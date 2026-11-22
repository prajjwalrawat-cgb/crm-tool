import 'server-only';

import { and, eq } from 'drizzle-orm';

import { prospects, prospectStageHistory, type ProspectStage } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { can } from '@/lib/rbac';

import {
  editBlock,
  normalizeProspectInput,
  prospectInputSchema,
  stageMoveBlock,
  type Actor,
  type ProspectInput,
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
} as const;

export const fail = (error: keyof typeof MESSAGES): MutationResult => ({ ok: false, error, message: MESSAGES[error] });

export const MAX_BULK = 500;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createProspect(
  tenantId: string,
  actor: Actor,
  input: ProspectInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!can(actor.role, 'manageProspects')) return { ok: false, error: MESSAGES.no_permission };
  const parsed = prospectInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const values = normalizeProspectInput(parsed.data);
  return tenantTransaction(async (tx) => {
    const [row] = await tx
      .insert(prospects)
      .values({ ...values, tenantId, createdBy: actor.userId, lastActivityAt: new Date() })
      .returning({ id: prospects.id });
    await tx.insert(prospectStageHistory).values({
      tenantId,
      prospectId: row!.id,
      fromStage: null,
      toStage: 'dump',
      changedBy: actor.userId,
    });
    return { ok: true as const, id: row!.id };
  });
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
