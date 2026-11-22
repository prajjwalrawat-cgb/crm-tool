import 'server-only';

import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import {
  aiSuggestions,
  aiSuggestionSources,
  calls,
  contacts,
  deals,
  emailMessages,
  communicationThreads,
  offerings,
  prospects,
  type AiSuggestion,
  type MembershipRole,
  type SuggestionField,
  type SuggestionSourceType,
  type SuggestionStatus,
  type SuggestionValue,
} from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { recordAiInvocation } from '@/lib/ai/audit';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';
import { fromMinorUnits } from '@/lib/deals/currency';
import { captureError } from '@/lib/observability';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { scopeUsers } from '@/lib/reports/manager/scope';

import { extractSuggestions, suggestionsClaudeConfigured, type ExtractInput, type ExtractResult } from './extract';
import { sameValue, validateFieldValue, type TargetValues } from './validate';

/**
 * AI suggestions: extraction runs (call / email), the review queue, and
 * accept / reject / edit-and-accept.
 *
 * Invariant: nothing in this module writes a deal, contact or prospect field. Applying
 * a suggestion goes through `Appliers` (appliers.ts), which call the same
 * server actions a user's manual edit calls, as the accepting user, so stage
 * gates, validation and RBAC apply unchanged. A failed apply leaves the
 * suggestion pending with the action's error.
 */

type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];
type Viewer = { userId: string; role: MembershipRole };

/* ------------------------------------------------------------ current values */

function localDay(d: Date, tz: string): string {
  try {
    return d.toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

async function dealValues(tx: Tx | DbExecutor, tenantId: string, dealId: string) {
  const [d] = await tx
    .select({
      id: deals.id,
      stage: deals.stage,
      amountMinor: deals.amountMinor,
      currency: deals.currency,
      expectedCloseDate: deals.expectedCloseDate,
      nextStep: deals.nextStep,
      ownerId: deals.ownerId,
      contactId: deals.contactId,
    })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId), isNull(deals.deletedAt)));
  if (!d) return null;
  const values: TargetValues = {
    stage: d.stage,
    amount: d.amountMinor != null ? fromMinorUnits(Number(d.amountMinor), d.currency) : null,
    close_date: d.expectedCloseDate ?? null,
    next_step: d.nextStep ?? null,
  };
  return { ...d, values };
}

async function contactValues(tx: Tx | DbExecutor, tenantId: string, contactId: string) {
  const [c] = await tx
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, phone: contacts.phone, title: contacts.title, ownerId: contacts.ownerId })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId), isNull(contacts.deletedAt)));
  if (!c) return null;
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  const values: TargetValues = {
    contact_name: name || null,
    contact_email: c.email ?? null,
    contact_phone: c.phone ?? null,
    contact_designation: c.title ?? null,
  };
  return { ...c, values };
}

/** Prospect enrichment fields (0079). A deleted prospect is not found. */
async function prospectValues(tx: Tx | DbExecutor, tenantId: string, prospectId: string) {
  const [p] = await tx
    .select({
      id: prospects.id,
      industry: prospects.industry,
      sizeBand: prospects.sizeBand,
      productFitOfferingId: prospects.productFitOfferingId,
      icpScore: prospects.icpScore,
    })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId), isNull(prospects.deletedAt)));
  if (!p) return null;
  const values: TargetValues = {
    industry: p.industry ?? null,
    size_band: p.sizeBand ?? null,
    product_fit: p.productFitOfferingId ?? null,
    icp_score: p.icpScore ?? null,
  };
  return { ...p, values };
}

/** The live value of a suggestion's field right now (for stale detection). */
export async function readLiveValue(tx: Tx, s: Pick<AiSuggestion, 'tenantId' | 'entityType' | 'entityId' | 'field'>): Promise<{ found: boolean; value: SuggestionValue }> {
  if (s.field === 'follow_up_task') return { found: true, value: null };
  if (s.entityType === 'prospect') {
    const p = await prospectValues(tx, s.tenantId, s.entityId);
    return p ? { found: true, value: p.values[s.field] ?? null } : { found: false, value: null };
  }
  if (s.entityType === 'contact') {
    const c = await contactValues(tx, s.tenantId, s.entityId);
    return c ? { found: true, value: c.values[s.field] ?? null } : { found: false, value: null };
  }
  const d = await dealValues(tx, s.tenantId, s.entityId);
  return d ? { found: true, value: d.values[s.field] ?? null } : { found: false, value: null };
}

/* ------------------------------------------------------------ persistence */

export type NewSuggestion = {
  entityType: 'deal' | 'contact' | 'lead' | 'prospect';
  entityId: string;
  field: SuggestionField;
  current: SuggestionValue;
  value: SuggestionValue;
  evidenceQuote: string;
  confidence: number;
};

/**
 * Insert pending suggestions for one source. Idempotent per
 * (source, entity, field) via the unique index. For prospect enrichment
 * (source_type 'enrichment', source_id = prospect id) the evidence quote is
 * the model's reasoning. Older pending suggestions
 * for the same entity + field from other sources are superseded (except
 * follow-up tasks, which are independent).
 */
export async function persistSuggestions(
  tx: Tx,
  args: { tenantId: string; sourceType: SuggestionSourceType; sourceId: string; model: string; items: NewSuggestion[] },
): Promise<number> {
  let inserted = 0;
  for (const it of args.items) {
    const rows = await tx
      .insert(aiSuggestions)
      .values({
        tenantId: args.tenantId,
        entityType: it.entityType,
        entityId: it.entityId,
        field: it.field,
        currentValueAtSuggestion: it.current,
        suggestedValue: it.value,
        evidenceQuote: it.evidenceQuote.slice(0, 500),
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        confidence: Math.max(0, Math.min(1, it.confidence)),
        model: args.model,
      })
      .onConflictDoNothing()
      .returning({ id: aiSuggestions.id });
    if (!rows[0]) continue;
    inserted++;
    if (it.field !== 'follow_up_task') {
      await tx
        .update(aiSuggestions)
        .set({ status: 'superseded', decidedAt: new Date(), decisionNote: 'Superseded by a newer suggestion' })
        .where(
          and(
            eq(aiSuggestions.tenantId, args.tenantId),
            eq(aiSuggestions.entityId, it.entityId),
            eq(aiSuggestions.field, it.field),
            eq(aiSuggestions.status, 'pending'),
            ne(aiSuggestions.id, rows[0].id),
          ),
        );
    }
  }
  return inserted;
}

/** Claim a source for extraction. False = already processed (or running). */
export async function claimSource(tx: Tx, tenantId: string, sourceType: SuggestionSourceType, sourceId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  const ins = await tx
    .insert(aiSuggestionSources)
    .values({ tenantId, sourceType, sourceId })
    .onConflictDoNothing()
    .returning({ id: aiSuggestionSources.sourceId });
  if (ins.length) return true;
  // A failed run, or a crashed one, may be retried.
  const re = await tx
    .update(aiSuggestionSources)
    .set({ status: 'running', error: null, updatedAt: new Date() })
    .where(
      and(
        eq(aiSuggestionSources.tenantId, tenantId),
        eq(aiSuggestionSources.sourceType, sourceType),
        eq(aiSuggestionSources.sourceId, sourceId),
        or(eq(aiSuggestionSources.status, 'failed'), and(eq(aiSuggestionSources.status, 'running'), lt(aiSuggestionSources.updatedAt, staleBefore))),
      ),
    )
    .returning({ id: aiSuggestionSources.sourceId });
  return re.length > 0;
}

export async function finishSource(tenantId: string, sourceType: SuggestionSourceType, sourceId: string, patch: { status: 'done' | 'failed' | 'skipped'; model?: string; count?: number; error?: string | null }) {
  await tenantTransaction((tx) =>
    tx
      .update(aiSuggestionSources)
      .set({ status: patch.status, model: patch.model ?? null, suggestionsCount: patch.count ?? 0, error: patch.error ?? null, updatedAt: new Date() })
      .where(and(eq(aiSuggestionSources.tenantId, tenantId), eq(aiSuggestionSources.sourceType, sourceType), eq(aiSuggestionSources.sourceId, sourceId))),
  );
}

/* ------------------------------------------------------------ extraction runs */

export type ExtractDeps = { extract?: (input: ExtractInput) => Promise<ExtractResult> };
export type RunResult = { status: 'done'; created: number; dropped: number } | { status: 'skipped' | 'noop'; reason: string } | { status: 'failed'; error: string; retryable: boolean };

async function runExtraction(args: {
  tenantId: string;
  sourceType: Exclude<SuggestionSourceType, 'enrichment'>;
  sourceId: string;
  text: string;
  date: string;
  deal: Awaited<ReturnType<typeof dealValues>>;
  contact: Awaited<ReturnType<typeof contactValues>>;
  allowFollowUp: boolean;
  deps: ExtractDeps;
}): Promise<RunResult> {
  const extract = args.deps.extract ?? ((i: ExtractInput) => extractSuggestions(i));
  const out = await extract({
    sourceType: args.sourceType,
    text: args.text,
    date: args.date,
    deal: args.deal ? { values: args.deal.values, currency: args.deal.currency } : null,
    contact: args.contact ? { values: args.contact.values } : null,
    allowFollowUp: args.allowFollowUp,
  });
  await recordAiInvocation({
    tenantId: args.tenantId,
    actorUserId: null,
    kind: 'ai_suggestions',
    model: out.usage.model,
    promptTokens: out.usage.inputTokens,
    completionTokens: out.usage.outputTokens,
    totalTokens: out.usage.inputTokens + out.usage.outputTokens,
    latencyMs: out.usage.latencyMs,
    status: out.ok ? 'success' : 'error',
    error: out.ok ? null : out.error,
    metadata: {
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      costUsdEstimate: out.usage.costUsd,
      suggestions: out.ok ? out.suggestions.length : 0,
      // Counts by reason only; never values or quotes.
      dropped: out.ok ? out.dropped.reduce<Record<string, number>>((m, d) => ((m[d.reason] = (m[d.reason] ?? 0) + 1), m), {}) : {},
    },
  }).catch((err) => captureError(err, { category: 'ai.suggestions.audit', retryable: false }));

  if (!out.ok) {
    await finishSource(args.tenantId, args.sourceType, args.sourceId, { status: 'failed', model: out.usage.model, error: out.error });
    return { status: 'failed', error: out.error, retryable: out.retryable };
  }
  const items: NewSuggestion[] = out.suggestions.map((s) => {
    const isDeal = s.target === 'deal';
    return {
      entityType: isDeal ? (args.deal!.stage === 'lead' ? 'lead' : 'deal') : 'contact',
      entityId: isDeal ? args.deal!.id : args.contact!.id,
      field: s.field,
      current: s.current,
      value: s.value,
      evidenceQuote: s.evidenceQuote,
      confidence: s.confidence,
    };
  });
  const created = await tenantTransaction((tx) =>
    persistSuggestions(tx, { tenantId: args.tenantId, sourceType: args.sourceType, sourceId: args.sourceId, model: out.usage.model, items }),
  );
  await finishSource(args.tenantId, args.sourceType, args.sourceId, { status: 'done', model: out.usage.model, count: created });
  return { status: 'done', created, dropped: out.dropped.length };
}

async function gate(tenantId: string, deps: ExtractDeps): Promise<string | null> {
  const settings = await getOrgSettings(tenantId);
  if (!settings.aiSuggestionsEnabled) return 'AI suggestions are turned off for this workspace.';
  if (!settings.aiEnabled) return 'AI is turned off for this workspace.';
  if (!deps.extract && !suggestionsClaudeConfigured()) return 'ANTHROPIC_API_KEY is not set.';
  return null;
}

/** From a call transcript (after the call summary). Runs in a system/tenant context. */
export async function runSuggestionsForCall(tenantId: string, callId: string, deps: ExtractDeps = {}): Promise<RunResult> {
  const why = await gate(tenantId, deps);
  if (why) return { status: 'skipped', reason: why };
  const ctx = await tenantTransaction(async (tx) => {
    const [call] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId)));
    if (!call?.transcript) return null;
    const deal = call.leadId ? await dealValues(tx, tenantId, call.leadId) : null;
    const contactId = call.contactId ?? deal?.contactId ?? null;
    const contact = contactId ? await contactValues(tx, tenantId, contactId) : null;
    if (!deal && !contact) return null;
    if (!(await claimSource(tx, tenantId, 'call', callId))) return 'claimed' as const;
    return { call, deal, contact };
  });
  if (ctx === null) return { status: 'noop', reason: 'no transcript or no linked deal/contact' };
  if (ctx === 'claimed') return { status: 'noop', reason: 'already processed' };
  const tz = (await getOrgSettings(tenantId)).timezone || 'Asia/Kolkata';
  return await runExtraction({
    tenantId,
    sourceType: 'call',
    sourceId: callId,
    text: ctx.call.transcript!,
    date: localDay(ctx.call.startedAt ?? ctx.call.createdAt, tz),
    deal: ctx.deal,
    contact: ctx.contact,
    allowFollowUp: false,
    deps,
  });
}

/** Strip quoted reply history so each message is only its new text. */
export function emailNewText(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^On .{4,200}wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim().slice(0, 4000);
}

/** From an email thread (after its thread summary). */
export async function runSuggestionsForEmail(tenantId: string, threadId: string, deps: ExtractDeps = {}): Promise<RunResult> {
  const why = await gate(tenantId, deps);
  if (why) return { status: 'skipped', reason: why };
  const ctx = await tenantTransaction(async (tx) => {
    const [thread] = await tx.select().from(communicationThreads).where(and(eq(communicationThreads.id, threadId), eq(communicationThreads.tenantId, tenantId)));
    if (!thread?.entityId || (thread.entityType !== 'deal' && thread.entityType !== 'contact')) return null;
    const msgs = await tx
      .select({ direction: emailMessages.direction, subject: emailMessages.subject, body: emailMessages.textBody, at: emailMessages.createdAt })
      .from(emailMessages)
      .where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.threadId, threadId)))
      .orderBy(emailMessages.createdAt)
      .limit(20);
    if (msgs.length === 0) return null;
    const deal = thread.entityType === 'deal' ? await dealValues(tx, tenantId, thread.entityId) : null;
    const contactId = thread.entityType === 'contact' ? thread.entityId : (deal?.contactId ?? null);
    const contact = contactId ? await contactValues(tx, tenantId, contactId) : null;
    if (!deal && !contact) return null;
    // Source id includes the message count, so a new reply is a new source.
    const sourceId = `${threadId}:${msgs.length}`;
    if (!(await claimSource(tx, tenantId, 'email', sourceId))) return 'claimed' as const;
    return { msgs, deal, contact, sourceId };
  });
  if (ctx === null) return { status: 'noop', reason: 'no messages or no linked deal/contact' };
  if (ctx === 'claimed') return { status: 'noop', reason: 'already processed' };
  const tz = (await getOrgSettings(tenantId)).timezone || 'Asia/Kolkata';
  const text = ctx.msgs
    .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'Rep'} · ${localDay(m.at, tz)}] ${m.subject}\n${emailNewText(m.body ?? '')}`)
    .join('\n\n');
  const last = ctx.msgs[ctx.msgs.length - 1]!.at;
  return await runExtraction({
    tenantId,
    sourceType: 'email',
    sourceId: ctx.sourceId,
    text,
    date: localDay(last, tz),
    deal: ctx.deal,
    contact: ctx.contact,
    allowFollowUp: true,
    deps,
  });
}

/**
 * The call summary's follow-up as a suggestion (field follow_up_task), so
 * there is one review mechanism. Written whenever the summary has a
 * follow_up_date, independent of ai_suggestions_enabled: it adds no new data
 * flow (the summary already exists) and keeps "Accept follow-up task"
 * working.
 */
export async function recordFollowUpSuggestion(tx: Tx, call: typeof calls.$inferSelect): Promise<boolean> {
  const s = call.aiSummary;
  if (!s?.follow_up_date || call.followUpTaskId) return false;
  const entityId = call.leadId ?? call.contactId;
  if (!entityId) return false;
  let entityType: 'deal' | 'lead' | 'contact' = 'contact';
  if (call.leadId) {
    const [d] = await tx.select({ stage: deals.stage }).from(deals).where(eq(deals.id, call.leadId));
    entityType = d?.stage === 'lead' ? 'lead' : 'deal';
  }
  const n = await persistSuggestions(tx, {
    tenantId: call.tenantId,
    sourceType: 'call',
    sourceId: call.id,
    model: 'call-summary',
    items: [
      {
        entityType,
        entityId,
        field: 'follow_up_task',
        current: null,
        value: { title: `Follow up: ${s.next_steps?.[0] ?? 'call follow-up'}`.slice(0, 200), due_date: s.follow_up_date },
        evidenceQuote: (s.next_steps?.[0] ?? s.summary).slice(0, 500),
        confidence: 0.7,
      },
    ],
  });
  return n > 0;
}

/* ------------------------------------------------------------ scope + queries */

export type SuggestionScope = { tenantId: string; userIds: string[] | null };

/** Who may see / decide a suggestion: the entity owner, their managers (reports_to subtree), admins. */
export async function suggestionScope(tenantId: string, viewer: Viewer, opts: { mineOnly?: boolean } = {}): Promise<SuggestionScope> {
  if (opts.mineOnly) return { tenantId, userIds: [viewer.userId] };
  const s = await scopeUsers({ tenantId, userId: viewer.userId, role: viewer.role });
  return { tenantId, userIds: s.userIds };
}

/**
 * The record's owner: deal / contact owner, or for a prospect its claimer,
 * else its creator. Every scope query joins the same three tables (FROM_JOINS).
 */
const ownerExpr = sql`COALESCE(d.owner_id, c.owner_id, p.claimed_by, p.created_by)`;
const entityNameExpr = sql`COALESCE(d.name, NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''), p.company_name)`;
const FROM_JOINS = sql`
      FROM ai_suggestions s
      LEFT JOIN deals d ON s.entity_type IN ('deal', 'lead') AND d.id = s.entity_id AND d.tenant_id = s.tenant_id
      LEFT JOIN contacts c ON s.entity_type = 'contact' AND c.id = s.entity_id AND c.tenant_id = s.tenant_id
      LEFT JOIN prospects p ON s.entity_type = 'prospect' AND p.id = s.entity_id AND p.tenant_id = s.tenant_id`;

function scopeSql(scope: SuggestionScope) {
  if (scope.userIds === null) return sql`TRUE`;
  if (scope.userIds.length === 0) return sql`FALSE`;
  return sql`${ownerExpr} IN (${sql.join(scope.userIds.map((u) => sql`${u}`), sql`, `)})`;
}

export type SuggestionRow = AiSuggestion & {
  ownerId: string | null;
  dealId: string | null;
  entityName: string | null;
  /** product_fit only: offering id -> name, for display (set by listSuggestions). */
  valueLabels: Record<string, string> | null;
  /** product_fit only: the tenant's active offerings, for edit-and-accept. */
  options: Array<{ value: string; label: string }> | null;
};

export async function listSuggestions(args: {
  scope: SuggestionScope;
  statuses?: SuggestionStatus[];
  entity?: { type: 'deal' | 'contact' | 'prospect'; ids: string[] };
  limit?: number;
}): Promise<SuggestionRow[]> {
  const statuses = args.statuses ?? ['pending'];
  const entityFilter = args.entity?.ids.length
    ? sql`AND s.entity_id IN (${sql.join(args.entity.ids.map((i) => sql`${i}::uuid`), sql`, `)})`
    : sql``;
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT s.*, ${ownerExpr} AS owner_id_resolved,
             d.id AS deal_id_resolved,
             ${entityNameExpr} AS entity_name
      ${FROM_JOINS}
      WHERE s.tenant_id = ${args.scope.tenantId}::uuid
        AND s.status IN (${sql.join(statuses.map((x) => sql`${x}`), sql`, `)})
        AND ${scopeSql(args.scope)}
        ${entityFilter}
      ORDER BY s.created_at DESC
      LIMIT ${args.limit ?? 200}
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return await withOfferingLabels(args.scope.tenantId, rows.map(toRow));
}

/**
 * Product-fit values are offering ids: attach the tenant's offering names
 * (all, so a retired one still reads as a name) and the active ones as edit
 * options. One query, only when a product_fit row is present.
 */
async function withOfferingLabels(tenantId: string, rows: SuggestionRow[]): Promise<SuggestionRow[]> {
  if (!rows.some((r) => r.field === 'product_fit')) return rows;
  const offs = await tenantTransaction((tx) =>
    tx
      .select({ id: offerings.id, name: offerings.name, active: offerings.active })
      .from(offerings)
      .where(eq(offerings.tenantId, tenantId))
      .orderBy(asc(offerings.name)),
  );
  const valueLabels = Object.fromEntries(offs.map((o) => [o.id, o.name]));
  const options = offs.filter((o) => o.active).map((o) => ({ value: o.id, label: o.name }));
  return rows.map((r) => (r.field === 'product_fit' ? { ...r, valueLabels, options } : r));
}

/** Ids of the tenant's active offerings (lowercase), for validating a product-fit edit. */
async function activeOfferingIds(tenantId: string): Promise<string[]> {
  const rows = await tenantTransaction((tx) =>
    tx.select({ id: offerings.id }).from(offerings).where(and(eq(offerings.tenantId, tenantId), eq(offerings.active, true))),
  );
  return rows.map((r) => r.id.toLowerCase());
}

function toRow(r: Record<string, unknown>): SuggestionRow {
  const d = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    entityType: r.entity_type as SuggestionRow['entityType'],
    entityId: String(r.entity_id),
    field: r.field as SuggestionField,
    currentValueAtSuggestion: (r.current_value_at_suggestion ?? null) as SuggestionValue,
    suggestedValue: r.suggested_value as SuggestionValue,
    evidenceQuote: String(r.evidence_quote),
    sourceType: r.source_type as SuggestionSourceType,
    sourceId: String(r.source_id),
    confidence: Number(r.confidence),
    status: r.status as SuggestionStatus,
    model: String(r.model),
    createdAt: d(r.created_at)!,
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: d(r.decided_at),
    decisionNote: (r.decision_note as string | null) ?? null,
    appliedValue: (r.applied_value ?? null) as SuggestionValue,
    liveValueAtDecision: (r.live_value_at_decision ?? null) as SuggestionValue,
    ownerId: (r.owner_id_resolved as string | null) ?? null,
    dealId: (r.deal_id_resolved as string | null) ?? null,
    entityName: (r.entity_name as string | null) ?? null,
    valueLabels: null,
    options: null,
  };
}

/** Nav badge: pending suggestions on records the viewer owns. */
export async function countMyPending(tenantId: string, userId: string): Promise<number> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT count(*)::int AS n
      ${FROM_JOINS}
      WHERE s.tenant_id = ${tenantId}::uuid AND s.status = 'pending' AND ${ownerExpr} = ${userId}
    `),
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------ decisions */

export type ApplyResult = { ok: true } | { ok: false; message: string };
export type ApplyContext = { tenantId: string; userId: string; role: MembershipRole; suggestion: SuggestionRow; value: SuggestionValue };
export type Appliers = Record<SuggestionField, (ctx: ApplyContext) => Promise<ApplyResult>>;

export type DecideInput = {
  tenantId: string;
  viewer: Viewer;
  id: string;
  action: 'accept' | 'reject' | 'edit';
  /** edit only: the user's value (validated like model output). */
  value?: unknown;
  note?: string | null;
};

export type DecideResult =
  | { ok: true; status: 'accepted' | 'rejected' }
  | { ok: false; stale: true; message: string; atSuggestion: SuggestionValue; live: SuggestionValue; suggested: SuggestionValue }
  | { ok: false; stale?: false; message: string };

const CLAIM_TTL_MS = 2 * 60_000;

export async function decideSuggestion(input: DecideInput, appliers: Appliers): Promise<DecideResult> {
  if (input.viewer.role === 'viewer') return { ok: false, message: 'Viewers cannot review suggestions.' };
  const scope = await suggestionScope(input.tenantId, input.viewer);
  const s = await findInScope(scope, input.id);
  if (!s) return { ok: false, message: 'Suggestion not found, or already decided.' };
  const note = input.note?.trim().slice(0, 500) || null;
  const today = new Date().toISOString().slice(0, 10);

  if (input.action === 'reject') {
    const done = await tenantTransaction(async (tx) => {
      const r = await tx
        .update(aiSuggestions)
        .set({ status: 'rejected', decidedBy: input.viewer.userId, decidedAt: new Date(), decisionNote: note })
        .where(and(eq(aiSuggestions.id, s.id), eq(aiSuggestions.tenantId, input.tenantId), eq(aiSuggestions.status, 'pending')))
        .returning({ id: aiSuggestions.id });
      if (r.length) await logDecision(tx, s, input.viewer.userId, 'rejected', { note, applied: null });
      return r.length > 0;
    });
    return done ? { ok: true, status: 'rejected' } : { ok: false, message: 'Suggestion was already decided.' };
  }

  // Value to apply: the suggestion's, or the user's edit re-validated.
  let value = s.suggestedValue;
  if (input.action === 'edit') {
    // A product-fit edit must name one of the tenant's ACTIVE offerings.
    const offeringIds = s.field === 'product_fit' ? await activeOfferingIds(input.tenantId) : undefined;
    const v = validateFieldValue(s.field, input.value, { today, offeringIds });
    if (!v.ok) return { ok: false, message: v.error };
    value = v.value;
  }

  // Claim (status stays pending until the apply succeeds) + stale check.
  const claim = await tenantTransaction(async (tx) => {
    const claimed = await tx
      .update(aiSuggestions)
      .set({ decidedBy: input.viewer.userId, decidedAt: new Date() })
      .where(
        and(
          eq(aiSuggestions.id, s.id),
          eq(aiSuggestions.tenantId, input.tenantId),
          eq(aiSuggestions.status, 'pending'),
          or(isNull(aiSuggestions.decidedAt), lt(aiSuggestions.decidedAt, new Date(Date.now() - CLAIM_TTL_MS))),
        ),
      )
      .returning({ id: aiSuggestions.id });
    if (!claimed.length) return { kind: 'busy' as const };
    const live = await readLiveValue(tx, s);
    if (!live.found) {
      await tx.update(aiSuggestions).set({ status: 'stale', liveValueAtDecision: null, decisionNote: 'The record no longer exists' }).where(eq(aiSuggestions.id, s.id));
      return { kind: 'gone' as const };
    }
    if (s.field !== 'follow_up_task' && !sameValue(live.value, s.currentValueAtSuggestion)) {
      await tx.update(aiSuggestions).set({ status: 'stale', liveValueAtDecision: live.value }).where(eq(aiSuggestions.id, s.id));
      await logDecision(tx, s, input.viewer.userId, 'stale', { note: null, applied: null, live: live.value });
      return { kind: 'stale' as const, live: live.value };
    }
    return { kind: 'ok' as const };
  });
  if (claim.kind === 'busy') return { ok: false, message: 'Someone is already applying this suggestion.' };
  if (claim.kind === 'gone') return { ok: false, message: 'The record no longer exists.' };
  if (claim.kind === 'stale') {
    return {
      ok: false,
      stale: true,
      message: 'This field changed after the suggestion was made, so it was not applied.',
      atSuggestion: s.currentValueAtSuggestion,
      live: claim.live,
      suggested: s.suggestedValue,
    };
  }

  // Apply through the normal edit path, as this user.
  let applied: ApplyResult;
  try {
    applied = await appliers[s.field]({ tenantId: input.tenantId, userId: input.viewer.userId, role: input.viewer.role, suggestion: s, value });
  } catch (err) {
    captureError(err, { category: 'ai.suggestions.apply', retryable: false, fields: { suggestionId: s.id, field: s.field } });
    applied = { ok: false, message: 'Could not apply the change.' };
  }
  if (!applied.ok) {
    await tenantTransaction((tx) =>
      tx.update(aiSuggestions).set({ decidedBy: null, decidedAt: null }).where(and(eq(aiSuggestions.id, s.id), eq(aiSuggestions.status, 'pending'))),
    );
    return { ok: false, message: applied.message };
  }
  await tenantTransaction(async (tx) => {
    await tx
      .update(aiSuggestions)
      .set({ status: 'accepted', decidedBy: input.viewer.userId, decidedAt: new Date(), decisionNote: note, appliedValue: value })
      .where(eq(aiSuggestions.id, s.id));
    await logDecision(tx, s, input.viewer.userId, 'accepted', { note, applied: value, edited: input.action === 'edit' });
  });
  return { ok: true, status: 'accepted' };
}

async function findInScope(scope: SuggestionScope, id: string): Promise<SuggestionRow | null> {
  const rows = (await tenantTransaction((tx) =>
    tx.execute(sql`
      SELECT s.*, ${ownerExpr} AS owner_id_resolved, d.id AS deal_id_resolved,
             ${entityNameExpr} AS entity_name
      ${FROM_JOINS}
      WHERE s.tenant_id = ${scope.tenantId}::uuid AND s.id = ${id}::uuid AND s.status = 'pending' AND ${scopeSql(scope)}
      LIMIT 1
    `),
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0] ? toRow(rows[0]) : null;
}

/** Every decision is an activity_logs row on the deal / contact / prospect, marked AI-originated. */
async function logDecision(
  tx: Tx,
  s: SuggestionRow,
  userId: string,
  outcome: 'accepted' | 'rejected' | 'stale',
  extra: { note: string | null; applied: SuggestionValue; edited?: boolean; live?: SuggestionValue },
) {
  await recordActivity(tx, {
    tenantId: s.tenantId,
    actorUserId: userId,
    entityType: s.entityType === 'contact' || s.entityType === 'prospect' ? s.entityType : 'deal',
    entityId: s.entityId,
    action: outcome === 'accepted' ? 'ai_suggestion_accepted' : outcome === 'rejected' ? 'ai_suggestion_rejected' : 'ai_suggestion_stale',
    metadata: {
      aiOriginated: true,
      suggestionId: s.id,
      field: s.field,
      from: s.currentValueAtSuggestion,
      suggested: s.suggestedValue,
      applied: extra.applied,
      edited: extra.edited ?? false,
      live: extra.live,
      evidence: s.evidenceQuote,
      confidence: s.confidence,
      model: s.model,
      sourceType: s.sourceType,
      sourceId: s.sourceId,
      decidedBy: userId,
      note: extra.note,
    },
  });
}

/* ------------------------------------------------------------ metrics */

export type SuggestionMetricRow = { key: string; accepted: number; rejected: number; stale: number; superseded: number; pending: number; rate: number | null };

/** Acceptance rate = accepted / (accepted + rejected). Stale and superseded are shown, not counted. */
export async function suggestionMetrics(tenantId: string, days = 90): Promise<{ byField: SuggestionMetricRow[]; byModel: SuggestionMetricRow[] }> {
  const q = (col: 'field' | 'model') =>
    tenantTransaction((tx) =>
      tx.execute(sql`
        SELECT ${sql.raw(col)} AS key,
               count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
               count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
               count(*) FILTER (WHERE status = 'stale')::int AS stale,
               count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
               count(*) FILTER (WHERE status = 'pending')::int AS pending
        FROM ai_suggestions
        WHERE tenant_id = ${tenantId}::uuid AND created_at > now() - make_interval(days => ${days})
        GROUP BY 1 ORDER BY 1
      `),
    ) as unknown as Promise<Array<Omit<SuggestionMetricRow, 'rate'>>>;
  const withRate = (rows: Array<Omit<SuggestionMetricRow, 'rate'>>) =>
    rows.map((r) => ({ ...r, rate: r.accepted + r.rejected > 0 ? r.accepted / (r.accepted + r.rejected) : null }));
  const [f, m] = await Promise.all([q('field'), q('model')]);
  return { byField: withRate(f), byModel: withRate(m) };
}

/** Pending follow-up suggestion for a call (the "Accept follow-up task" button). */
export async function pendingFollowUpForCall(tenantId: string, callId: string): Promise<string | null> {
  const [r] = await tenantTransaction((tx) =>
    tx
      .select({ id: aiSuggestions.id })
      .from(aiSuggestions)
      .where(
        and(
          eq(aiSuggestions.tenantId, tenantId),
          eq(aiSuggestions.sourceType, 'call'),
          eq(aiSuggestions.sourceId, callId),
          eq(aiSuggestions.field, 'follow_up_task'),
          inArray(aiSuggestions.status, ['pending']),
        ),
      ),
  );
  return r?.id ?? null;
}
