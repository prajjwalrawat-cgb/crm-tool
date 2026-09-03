/**
 * Stage governance — the funnel's ordering, what a stage owes the forecast,
 * and what a chronically-pushed deal is worth toward quota.
 *
 * Pure and client-safe (no DB, no `server-only`): the board card, the edit
 * form, the server actions, the DB trigger's mirror-image logic and the
 * self-test all read the same constants, so a badge, a rejection message and
 * a quota number cannot drift apart.
 *
 * Companion rules live in `./validation` (Lead can't be dated, margin from
 * Qualified on) and `./slip` (the pushback severity the card renders). This
 * module is the governance layer over both.
 */

import { DEAL_STAGE_LABELS, type DealStage } from './schema';

/* ------------------------------------------------------------------ *
 * Funnel order (R2)
 * ------------------------------------------------------------------ */

/**
 * The ordered sales funnel. Deliberately excludes `hold` and `lost`: they are
 * PARKING states, not rungs on a ladder.
 *
 * Ordering them would make every legitimate move a false rollback — parking a
 * Negotiation deal, or reopening a lost one — and demanding a rollback reason
 * for those is both wrong (they already capture their own reason: `holdReason`,
 * `lostReason`) and a dead end for the rep. A transition with an unranked stage
 * on either side is therefore never a rollback.
 */
export const FUNNEL_STAGE_ORDER = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGE_ORDER)[number];

const STAGE_RANK: Partial<Record<DealStage, number>> = Object.fromEntries(
  FUNNEL_STAGE_ORDER.map((s, i) => [s, i + 1]),
);

/**
 * 1-based position in the funnel, or null for an unordered stage
 * (`hold` / `lost`). Mirrors the `deal_stage_rank()` SQL function in
 * migration 0060 — change both together.
 */
export function stageRank(stage: string): number | null {
  return STAGE_RANK[stage as DealStage] ?? null;
}

/**
 * R2 — is this a backward move through the funnel? True only when BOTH stages
 * are ranked and the target sits lower. Every such move needs a reason code.
 */
export function isRollbackTransition(from: string, to: string): boolean {
  const a = stageRank(from);
  const b = stageRank(to);
  return a != null && b != null && b < a;
}

/** Is this a forward move through the funnel? (The complement of the above.) */
export function isForwardTransition(from: string, to: string): boolean {
  const a = stageRank(from);
  const b = stageRank(to);
  return a != null && b != null && b > a;
}

/* ------------------------------------------------------------------ *
 * Rollback reason codes (R2)
 * ------------------------------------------------------------------ */

export const ROLLBACK_REASONS = [
  'requirement_changed',
  'budget_lost',
  'champion_left',
  'wrong_stage_advance',
  'competitor_reintroduced',
  'other',
] as const;
export type RollbackReason = (typeof ROLLBACK_REASONS)[number];

export const ROLLBACK_REASON_LABELS: Record<RollbackReason, string> = {
  requirement_changed: 'Requirement changed',
  budget_lost: 'Budget lost',
  champion_left: 'Champion left',
  wrong_stage_advance: 'Wrong stage advance (data entry error)',
  competitor_reintroduced: 'Competitor reintroduced',
  other: 'Other',
};

export function isRollbackReason(v: unknown): v is RollbackReason {
  return (
    typeof v === 'string' &&
    (ROLLBACK_REASONS as readonly string[]).includes(v)
  );
}

/**
 * Reason codes the SYSTEM writes for backward moves it makes on the user's
 * behalf. They are not offered in the dropdown — a rep never picks them — but
 * they satisfy the same "no unexplained rollback" rule, so the audit trail has
 * no holes where automation moved a deal.
 *
 *   `approval_rejected` — a manager rejected a Won deal, reopening it to
 *                         Negotiation (see rejectDealAction).
 *   `lead_close_date_cleanup` — the Lead close-date backfill sending a deal
 *                         back to Lead (see revertDealToLead).
 */
export const SYSTEM_ROLLBACK_REASONS = {
  approvalRejected: 'approval_rejected',
  leadCloseDateCleanup: 'lead_close_date_cleanup',
} as const;

/** Display text for any stored reason code, system codes included. */
export function rollbackReasonLabel(code: string | null): string {
  if (!code) return '—';
  if (isRollbackReason(code)) return ROLLBACK_REASON_LABELS[code];
  if (code === SYSTEM_ROLLBACK_REASONS.approvalRejected) {
    return 'Reopened by manager rejection';
  }
  if (code === SYSTEM_ROLLBACK_REASONS.leadCloseDateCleanup) {
    return 'Sent back to Lead (close-date cleanup)';
  }
  return code;
}

export const ROLLBACK_REASON_REQUIRED_MESSAGE =
  'Moving a deal backward needs a reason.';

/* ------------------------------------------------------------------ *
 * Close date required late in the funnel (R1, R3)
 * ------------------------------------------------------------------ */

/**
 * Stages a deal cannot enter — or remain in — without an expected close date.
 *
 * The bookend to `violatesLeadCloseDate`: a Lead may NOT carry a date (it
 * hasn't earned one), and from Proposal on it MUST (a deal being quoted with
 * no committed date is unforecastable and inflates weighted pipeline with
 * false precision). Qualified is the deliberate gap between the two — the deal
 * is real but the date is still a guess.
 *
 * `hold` and `lost` are absent on purpose: requiring a date to park or close a
 * deal would strand a dateless Proposal deal with nowhere legal to go.
 */
export const CLOSE_DATE_REQUIRED_STAGES = [
  'proposal',
  'negotiation',
  'won',
] as const;

/** Must a deal in `stage` carry an expected close date? */
export function closeDateRequiredForStage(stage: string): boolean {
  return (CLOSE_DATE_REQUIRED_STAGES as readonly string[]).includes(stage);
}

/**
 * R1 — does this (stage, date) pair violate the requirement? Blank strings
 * count as missing: an emptied date input posts `''`, not null.
 */
export function violatesMissingCloseDate(
  stage: string,
  expectedCloseDate: string | null | undefined,
): boolean {
  if (!closeDateRequiredForStage(stage)) return false;
  return (
    typeof expectedCloseDate !== 'string' ||
    expectedCloseDate.trim().length === 0
  );
}

/** Names the stage, so the rep knows which rule they hit. */
export function closeDateRequiredMessage(stage: string): string {
  const label = DEAL_STAGE_LABELS[stage as DealStage] ?? stage;
  return `An expected close date is required to be in ${label}.`;
}

export const CLOSE_DATE_CLEAR_BLOCKED_MESSAGE =
  'The close date can’t be cleared while the deal is in Proposal or Negotiation. ' +
  'Set a new date, or move the deal back a stage with a reason.';

/**
 * R3 — is this an attempt to blank an existing date on a deal that stays in a
 * date-required stage? Setting a *different* date is a pushback (R4), not a
 * clear, and is always allowed.
 *
 * The escape hatch is a stage rollback: pass the stage the deal will END UP in
 * as `nextStage`, so a move to Lead (which legitimately drops the date) is not
 * caught here.
 */
export function violatesCloseDateClear(params: {
  nextStage: string;
  previousCloseDate: string | null | undefined;
  nextCloseDate: string | null | undefined;
}): boolean {
  const had = !!params.previousCloseDate;
  const has =
    typeof params.nextCloseDate === 'string' &&
    params.nextCloseDate.trim().length > 0;
  return had && !has && closeDateRequiredForStage(params.nextStage);
}

/* ------------------------------------------------------------------ *
 * Quota de-weighting (R6, R7)
 * ------------------------------------------------------------------ */

/**
 * Pushes a deal may accumulate before its quota credit is halved. STRICTLY
 * greater-than: 3 pushes still count in full, the 4th triggers the haircut.
 *
 * Intentionally NOT the same knob as `SEVERE_PUSH_COUNT` in `./slip`, which is
 * a >= 3 display threshold. A card can look worrying (amber, 3 pushes) before
 * it costs the rep anything — the warning lands one push before the penalty,
 * which is the point.
 */
export const QUOTA_DEWEIGHT_PUSH_COUNT = 3;

export const FULL_QUOTA_WEIGHT = 1;
export const DEWEIGHTED_QUOTA_WEIGHT = 0.5;

/** R6 — the weight a deal with this many pushes earns. */
export function quotaWeightFor(pushCount: number | null | undefined): number {
  return (pushCount ?? 0) > QUOTA_DEWEIGHT_PUSH_COUNT
    ? DEWEIGHTED_QUOTA_WEIGHT
    : FULL_QUOTA_WEIGHT;
}

/** Is this deal currently counting at less than face value? */
export function isDeweighted(quotaWeight: number | null | undefined): boolean {
  return (quotaWeight ?? FULL_QUOTA_WEIGHT) < FULL_QUOTA_WEIGHT;
}

/**
 * R7 — an amount's quota-credited value in minor units. Rounded, because minor
 * units are integers and a half-cent of attainment is not a thing. Mirrors the
 * SQL (`ROUND(amount_minor * quota_weight)`) used by the aggregate queries.
 */
export function weightedQuotaMinor(
  amountMinor: number,
  quotaWeight: number | null | undefined,
): number {
  return Math.round(amountMinor * (quotaWeight ?? FULL_QUOTA_WEIGHT));
}

/** Percentage for display: 0.5 -> "50%". */
export function quotaWeightPercentLabel(
  quotaWeight: number | null | undefined,
): string {
  return `${Math.round((quotaWeight ?? FULL_QUOTA_WEIGHT) * 100)}%`;
}

/**
 * The tooltip on an escalated Pushed badge. Says the consequence out loud —
 * a silent haircut teaches nobody anything, and the whole point of R6 is to
 * make habitual pushing visible to the person doing it.
 */
export function deweightTooltip(pushCount: number | null | undefined): string {
  return (
    `Counted at ${quotaWeightPercentLabel(DEWEIGHTED_QUOTA_WEIGHT)} toward quota — ` +
    `pushed ${pushCount ?? 0}× (more than ${QUOTA_DEWEIGHT_PUSH_COUNT}).`
  );
}

/** Badge text for a deal that has been rolled back. */
export function rollbackChipLabel(rollbackCount: number | null): string {
  const n = rollbackCount ?? 0;
  return `Rolled back ×${n}`;
}

/* ------------------------------------------------------------------ *
 * Audit trail vocabulary (R5)
 * ------------------------------------------------------------------ */

/** Fields whose every mutation is written to `deal_audit_log`. */
export const AUDITED_DEAL_FIELDS = [
  'stage',
  'expected_close_date',
  'amount_minor',
] as const;
export type AuditedDealField = (typeof AUDITED_DEAL_FIELDS)[number];

export const AUDIT_CHANGE_TYPES = [
  'forward_progress',
  'rollback',
  'pushback',
  'edit',
] as const;
export type AuditChangeType = (typeof AUDIT_CHANGE_TYPES)[number];

export const AUDIT_FIELD_LABELS: Record<string, string> = {
  stage: 'Stage',
  expected_close_date: 'Close date',
  amount_minor: 'Amount',
};

export const AUDIT_CHANGE_TYPE_LABELS: Record<AuditChangeType, string> = {
  forward_progress: 'Advanced',
  rollback: 'Rolled back',
  pushback: 'Pushed back',
  edit: 'Edited',
};
