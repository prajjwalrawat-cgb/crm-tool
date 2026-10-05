/**
 * Manager/admin roll-up: one engine run per resource, and totals that are
 * the exact sum of those runs. Nothing here re-derives a payout — it only
 * calls the engine and adds up what came back.
 *
 * Pure + client-safe.
 */
import {
  calculateIncentive,
  creditedRevenueForFullTarget,
  resourceFlags,
  sumPayoutsL,
  type IncentiveActuals,
  type IncentivePlanTerms,
  type IncentiveResult,
  type ResourceFlags,
  type TargetRevenueNeeded,
} from './engine';
import { Rational, type Decimalish } from './rational';

export type PlanStatus = 'draft' | 'active' | 'closed';

export type RollupInput = {
  planId: string;
  userId: string;
  displayName: string;
  status: PlanStatus;
  terms: IncentivePlanTerms;
  actuals: IncentiveActuals | null;
};

export type RollupRow = RollupInput & {
  /** Null when no actuals have been recorded yet — never a fabricated ₹0. */
  result: IncentiveResult | null;
  flags: ResourceFlags | null;
  needed: TargetRevenueNeeded;
  error: string | null;
};

export type RollupTotals = {
  resources: number;
  projectedPayoutL: number;
  targetVariableL: number;
  belowGate: number;
  marginMiss: number;
  breach: number;
  missingActuals: number;
  budgetL: number | null;
  budgetRemainingL: number | null;
};

export function buildRollup(
  inputs: readonly RollupInput[],
  opts: { budgetL?: Decimalish | null } = {},
): { rows: RollupRow[]; totals: RollupTotals } {
  const rows = inputs.map((i): RollupRow => {
    const needed = safeNeeded(i.terms);
    if (!i.actuals) return { ...i, result: null, flags: null, needed, error: null };
    try {
      const result = calculateIncentive(i.terms, i.actuals);
      return { ...i, result, flags: resourceFlags(i.terms, i.actuals, result), needed, error: null };
    } catch (e) {
      return { ...i, result: null, flags: null, needed, error: e instanceof Error ? e.message : String(e) };
    }
  });
  const payout = sumPayoutsL(rows.map((r) => r.result?.finalPayoutL ?? 0));
  const budget = opts.budgetL != null && opts.budgetL !== '' ? Rational.parse(opts.budgetL as string | number) : null;
  return {
    rows,
    totals: {
      resources: rows.length,
      projectedPayoutL: payout,
      targetVariableL: sumPayoutsL(inputs.map((i) => Number(i.terms.targetVariable) || 0)),
      belowGate: rows.filter((r) => r.flags?.belowGate).length,
      marginMiss: rows.filter((r) => r.flags?.marginMiss).length,
      breach: rows.filter((r) => r.flags?.breach).length,
      missingActuals: rows.filter((r) => !r.actuals).length,
      budgetL: budget ? budget.toNumber(6) : null,
      budgetRemainingL: budget ? budget.sub(Rational.parse(payout)).toNumber(6) : null,
    },
  };
}

function safeNeeded(terms: IncentivePlanTerms): TargetRevenueNeeded {
  try {
    return creditedRevenueForFullTarget(terms);
  } catch {
    return { reachable: false, creditedRevenueCr: null, reason: 'no_rate_above_gate' };
  }
}
