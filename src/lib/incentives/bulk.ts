/**
 * Bulk rule changes across many plans (e.g. "slab 2 rate goes to 2.5 for
 * everyone next year"), with a per-resource payout preview BEFORE anything
 * is written. The preview and the write both go through `applyBulkChange`,
 * so what the admin confirmed is exactly what lands.
 *
 * Pure + client-safe.
 */
import {
  calculateIncentive,
  validatePlanTerms,
  type IncentiveActuals,
  type IncentivePlanTerms,
} from './engine';
import { Rational } from './rational';
import { BULK_TERM_KEYS, type TermKey } from './terms';

export type BulkChange = Partial<Pick<IncentivePlanTerms, TermKey>>;

/** Only rule fields may be bulk-changed; CTC and target stay per resource. */
export function sanitizeBulkChange(change: Record<string, unknown>): BulkChange {
  const out: Record<string, unknown> = {};
  for (const key of BULK_TERM_KEYS) {
    if (change[key] !== undefined && change[key] !== '') out[key] = change[key];
  }
  return out as BulkChange;
}

export function applyBulkChange(terms: IncentivePlanTerms, change: BulkChange): IncentivePlanTerms {
  return { ...terms, ...sanitizeBulkChange(change as Record<string, unknown>) };
}

export type BulkPreviewInput = {
  planId: string;
  userId: string;
  terms: IncentivePlanTerms;
  /** Latest actuals; null = none recorded, previewed at zero revenue. */
  actuals: IncentiveActuals | null;
};

export type BulkPreviewRow = {
  planId: string;
  userId: string;
  beforeL: number;
  afterL: number;
  deltaL: number;
  /** Set when the change would make this plan invalid; nothing is applied then. */
  error: string | null;
  usedZeroActuals: boolean;
};

const ZERO_ACTUALS: IncentiveActuals = { priorYearRevenueCr: 0, netNewRevenueCr: 0, blendedMarginPct: 0 };

export function previewBulkChange(
  plans: readonly BulkPreviewInput[],
  change: BulkChange,
): { rows: BulkPreviewRow[]; totalBeforeL: number; totalAfterL: number; totalDeltaL: number; invalidCount: number } {
  let before = Rational.ZERO;
  let after = Rational.ZERO;
  const rows = plans.map((p): BulkPreviewRow => {
    const actuals = p.actuals ?? ZERO_ACTUALS;
    const next = applyBulkChange(p.terms, change);
    const issues = validatePlanTerms(next);
    const b = calculateIncentive(p.terms, actuals).finalPayoutL;
    if (issues.length > 0) {
      return { planId: p.planId, userId: p.userId, beforeL: b, afterL: b, deltaL: 0, error: issues.join('; '), usedZeroActuals: !p.actuals };
    }
    const a = calculateIncentive(next, actuals).finalPayoutL;
    before = before.add(Rational.parse(b));
    after = after.add(Rational.parse(a));
    return {
      planId: p.planId,
      userId: p.userId,
      beforeL: b,
      afterL: a,
      deltaL: Rational.parse(a).sub(Rational.parse(b)).toNumber(6),
      error: null,
      usedZeroActuals: !p.actuals,
    };
  });
  return {
    rows,
    totalBeforeL: before.toNumber(6),
    totalAfterL: after.toNumber(6),
    totalDeltaL: after.sub(before).toNumber(6),
    invalidCount: rows.filter((r) => r.error).length,
  };
}
