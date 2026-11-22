import 'server-only';

import { and, eq, inArray } from 'drizzle-orm';

import { offerings, prospects, prospectStageHistory, type ProspectStage } from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';
import { sendWorkflowEvent, sendWorkflowEventsBatch } from '@/lib/inngest/send';
import { captureError } from '@/lib/observability';
import { can } from '@/lib/rbac';

import {
  editBlock,
  normalizeProspectInput,
  prospectInputSchema,
  stageMoveBlock,
  type Actor,
  type ProspectInput,
  type ProspectRowValues,
} from './rules';

export type MutationResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not_found' | 'promoted' | 'deleted' | 'claimed_by_other' | 'no_permission' | 'invalid' | 'not_claimed' | 'out_of_scope';
      message: string;
    };

export const MESSAGES = {
  not_found: 'Prospect not found.',
  promoted: 'Already promoted to a lead.',
  deleted: 'This prospect was deleted.',
  claimed_by_other: 'Claimed by someone else. Only they or a manager can move it.',
  no_permission: 'You do not have permission.',
  not_claimed: 'Not claimed.',
  out_of_scope: 'That person is outside your team.',
  cannot_claim: "That person can't claim prospects.",
} as const;

/** A product-fit offering id that is not one of the tenant's offerings. */
export const UNKNOWN_PRODUCT = 'Unknown product.';

export const fail = (error: Exclude<keyof typeof MESSAGES, 'cannot_claim'>): MutationResult => ({ ok: false, error, message: MESSAGES[error] });

export const MAX_BULK = 500;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event seams (selftests inject recorders; production sends through Inngest). */
export type ProspectEventDeps = { sendEvent?: typeof sendWorkflowEvent; sendEvents?: typeof sendWorkflowEventsBatch };

/**
 * After commit, best-effort: `crm/prospect.created` for one new prospect (AI
 * enrichment listens). Never throws, so a failed send never fails the user's
 * action.
 */
export async function emitProspectCreated(tenantId: string, prospectId: string, deps: ProspectEventDeps = {}): Promise<void> {
  try {
    await (deps.sendEvent ?? sendWorkflowEvent)('crm/prospect.created', { tenantId, prospectId });
  } catch (err) {
    captureError(err, { category: 'prospects.event_send_failed', severity: 'low', retryable: false, fields: { tenantId, prospectId } });
  }
}

/**
 * The same for many prospects (Quick Dump confirm): one batched send, chunked
 * by sendWorkflowEventsBatch; on the local fallback the handlers run in the
 * background, so the request never waits on enrichment. Never throws.
 */
export async function emitProspectsCreated(tenantId: string, ids: string[], deps: ProspectEventDeps = {}): Promise<void> {
  if (ids.length === 0) return;
  try {
    await (deps.sendEvents ?? sendWorkflowEventsBatch)(
      'crm/prospect.created',
      ids.map((prospectId) => ({ tenantId, prospectId })),
    );
  } catch (err) {
    captureError(err, { category: 'prospects.event_send_failed', severity: 'low', retryable: false, fields: { tenantId, count: ids.length } });
  }
}

export async function createProspect(
  tenantId: string,
  actor: Actor,
  input: ProspectInput,
  deps: ProspectEventDeps = {},
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!can(actor.role, 'manageProspects')) return { ok: false, error: MESSAGES.no_permission };
  const parsed = prospectInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const values = normalizeProspectInput(parsed.data);
  const res = await tenantTransaction(async (tx) => {
    const r = await insertProspectRows(tx, tenantId, actor, [values]);
    if (!r.ok) return { ok: false as const, error: UNKNOWN_PRODUCT };
    return { ok: true as const, id: r.ids[0]! };
  });
  if (res.ok) await emitProspectCreated(tenantId, res.id, deps);
  return res;
}

/** Indexes of rows whose non-null productFitOfferingId is not one of this tenant's offerings. */
async function unknownOfferingRows(tx: DbExecutor, tenantId: string, ids: Array<string | null>): Promise<number[]> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return [];
  const found = await tx
    .select({ id: offerings.id })
    .from(offerings)
    .where(and(eq(offerings.tenantId, tenantId), inArray(offerings.id, wanted)));
  const known = new Set(found.map((o) => o.id));
  return ids.flatMap((id, i) => (id && !known.has(id) ? [i] : []));
}

/**
 * Inserts already-validated, normalised prospect rows in stage `dump` and
 * writes one history row each (null -> 'dump'). Shared by createProspect and
 * the Quick Dump confirm; runs inside the caller's transaction. Nothing is
 * inserted when any row's product-fit offering is not one of the tenant's
 * (`unknownOffering` lists those rows' indexes).
 */
export async function insertProspectRows(
  tx: DbExecutor,
  tenantId: string,
  actor: Actor,
  rows: ProspectRowValues[],
  opts: { importId?: string } = {},
): Promise<{ ok: true; ids: string[] } | { ok: false; unknownOffering: number[] }> {
  if (rows.length === 0) return { ok: true, ids: [] };
  const unknownOffering = await unknownOfferingRows(tx, tenantId, rows.map((r) => r.productFitOfferingId));
  if (unknownOffering.length > 0) return { ok: false, unknownOffering };
  const now = new Date();
  const inserted = await tx
    .insert(prospects)
    .values(rows.map((values) => ({ ...values, tenantId, importId: opts.importId ?? null, createdBy: actor.userId, lastActivityAt: now })))
    .returning({ id: prospects.id });
  await tx.insert(prospectStageHistory).values(
    inserted.map((r) => ({ tenantId, prospectId: r.id, fromStage: null, toStage: 'dump' as const, changedBy: actor.userId })),
  );
  return { ok: true, ids: inserted.map((r) => r.id) };
}

export async function updateProspect(
  tenantId: string,
  actor: Actor,
  id: string,
  input: Partial<ProspectInput>,
): Promise<MutationResult> {
  if (!UUID_RE.test(id)) return fail('not_found');
  return tenantTransaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return fail('not_found');
    const block = editBlock(cur, actor);
    if (block) return fail(block);

    // Merge onto the current row so partial updates re-normalize consistently.
    const merged = {
      companyName: cur.companyName,
      domain: cur.domain,
      contactName: cur.contactName,
      contactDesignation: cur.contactDesignation,
      contactEmail: cur.contactEmail,
      contactPhone: cur.contactPhone,
      industry: cur.industry,
      sizeBand: cur.sizeBand,
      city: cur.city,
      state: cur.state,
      productFitOfferingId: cur.productFitOfferingId,
      icpScore: cur.icpScore,
      clusterTags: cur.clusterTags,
      sourceTag: cur.sourceTag,
      notes: cur.notes,
      ...input,
    };
    const parsed = prospectInputSchema.safeParse(merged);
    if (!parsed.success) return { ok: false, error: 'invalid', message: parsed.error.message } as MutationResult;
    const values = normalizeProspectInput(parsed.data);
    if ((await unknownOfferingRows(tx, tenantId, [values.productFitOfferingId])).length > 0) {
      return { ok: false, error: 'invalid', message: UNKNOWN_PRODUCT } as MutationResult;
    }
    const now = new Date();
    await tx
      .update(prospects)
      .set({ ...values, lastActivityAt: now, updatedAt: now })
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));
    return { ok: true } as MutationResult;
  });
}

export async function moveProspectStage(
  tenantId: string,
  actor: Actor,
  id: string,
  to: ProspectStage,
): Promise<MutationResult> {
  if (!UUID_RE.test(id)) return fail('not_found');
  return tenantTransaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return fail('not_found');
    const block = stageMoveBlock(cur, to, actor);
    if (block === 'same_stage') return { ok: true } as MutationResult;
    if (block) return fail(block);

    const now = new Date();
    await tx
      .update(prospects)
      .set({
        stage: to,
        stageChangedAt: now,
        parkedReason: to === 'parked' ? 'manual' : null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));
    await tx.insert(prospectStageHistory).values({
      tenantId,
      prospectId: id,
      fromStage: cur.stage,
      toStage: to,
      changedBy: actor.userId,
    });
    return { ok: true } as MutationResult;
  });
}

export async function bulkMoveStage(
  tenantId: string,
  actor: Actor,
  ids: string[],
  to: ProspectStage,
): Promise<{ moved: string[]; skipped: { id: string; reason: string }[] }> {
  if (ids.length > MAX_BULK) return { moved: [], skipped: ids.map((id) => ({ id, reason: 'invalid' })) };
  if (to === 'parked' && ids.length > 1 && !can(actor.role, 'bulkParkProspects')) {
    return { moved: [], skipped: ids.map((id) => ({ id, reason: 'no_permission' })) };
  }
  const moved: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    try {
      const r = await moveProspectStage(tenantId, actor, id, to);
      if (r.ok) moved.push(id);
      else skipped.push({ id, reason: r.error });
    } catch (err) {
      console.error('bulkMoveStage: move failed', id, err);
      skipped.push({ id, reason: 'error' });
    }
  }
  return { moved, skipped };
}
