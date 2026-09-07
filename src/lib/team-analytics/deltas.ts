import {
  computeDelta,
  computePointsDelta,
  type Delta,
} from '@/lib/dashboard/delta';

/**
 * PERIOD-OVER-PERIOD DELTAS for the team scorecard.
 *
 * Pure + client-safe. The arithmetic itself is `@/lib/dashboard/delta`,
 * unchanged and shared with both dashboards — this module only decides, per
 * metric, WHICH of those two functions applies and WHICH DIRECTION IS GOOD.
 *
 * ---------------------------------------------------------------
 * DIRECTION IS PER METRIC, AND GETTING IT WRONG IS WORSE THAN OMITTING IT
 * ---------------------------------------------------------------
 * A green up-arrow on "close dates pushed" would congratulate a team for the
 * exact behaviour the section exists to expose. Three of the five headline
 * metrics improve by going UP and two by going DOWN, so the direction lives
 * in a table here rather than in the renderer, where a copy-paste would
 * silently invert one tile.
 *
 * ---------------------------------------------------------------
 * RATES USE POINTS, COUNTS USE PERCENTAGES
 * ---------------------------------------------------------------
 * Attainment and completeness are ratios: they move in percentage POINTS,
 * which are bounded by construction. Reporting "+40%" for 50%→70% invites
 * the reader to compare it against a count that moved 40% and mean something
 * different. Counts go through `computeDelta`, which has its own escape
 * hatches for a near-zero baseline (see that module).
 */

export type MetricDeltaKey =
  | 'attainment'
  | 'pushEvents'
  | 'dealsCreated'
  | 'staleOpenDeals'
  | 'completeness';

/**
 * Which way is up, per metric.
 *
 *   attainment      ↑ good — more of the target banked
 *   completeness    ↑ good — fewer missing fields
 *   dealsAdded      ↑ good — more pipeline created
 *   pushEvents      ↓ good — fewer close dates moved
 *   staleOpenDeals  ↓ good — fewer deals left untouched
 */
export const DELTA_HIGHER_IS_BETTER: Record<MetricDeltaKey, boolean> = {
  attainment: true,
  completeness: true,
  dealsCreated: true,
  pushEvents: false,
  staleOpenDeals: false,
};

export type ScorecardDelta = {
  delta: Delta;
  /**
   * The snapshot period the comparison came from ('2026-08'), or null when
   * there is none — the first-run case, which every renderer must show as
   * "no comparison yet" rather than as a 0% change.
   */
  baselinePeriod: string | null;
  higherIsBetter: boolean;
};

export type ScorecardDeltaSet = Record<MetricDeltaKey, ScorecardDelta>;

/** Current-period figures a delta set is built from. */
export type DeltaInputs = {
  fyRevenueMinor: number;
  revenueTargetMinor: number;
  pushEvents: number;
  dealsCreated: number;
  staleOpenDeals: number;
  completenessFilled: number;
  completenessApplicable: number;
};

/** The same figures at the baseline, each null when not snapshotted. */
export type PriorInputs = {
  fyRevenueMinor: number | null;
  revenueTargetMinor: number | null;
  pushEvents: number | null;
  dealsCreated: number | null;
  staleOpenDeals: number | null;
  completenessFilled: number | null;
  completenessApplicable: number | null;
  /** Which period each kind of metric was read from. */
  cumulativePeriod: string | null;
  statePeriod: string | null;
};

const NO_DELTA = (higherIsBetter: boolean): ScorecardDelta => ({
  delta: { kind: 'none' },
  baselinePeriod: null,
  higherIsBetter,
});

/** A ratio, or null when the denominator makes one meaningless. */
function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function buildDeltas(
  current: DeltaInputs,
  prior: PriorInputs,
): ScorecardDeltaSet {
  const countDelta = (
    key: MetricDeltaKey,
    currentValue: number,
    priorValue: number | null,
    period: string | null,
  ): ScorecardDelta => {
    const higherIsBetter = DELTA_HIGHER_IS_BETTER[key];
    if (priorValue == null || period == null) return NO_DELTA(higherIsBetter);
    return {
      delta: computeDelta(currentValue, priorValue),
      baselinePeriod: period,
      higherIsBetter,
    };
  };

  const rateDelta = (
    key: MetricDeltaKey,
    currentRate: number | null,
    priorRate: number | null,
    period: string | null,
  ): ScorecardDelta => {
    const higherIsBetter = DELTA_HIGHER_IS_BETTER[key];
    if (currentRate == null || priorRate == null || period == null) {
      return NO_DELTA(higherIsBetter);
    }
    return {
      delta: computePointsDelta(currentRate, priorRate),
      baselinePeriod: period,
      higherIsBetter,
    };
  };

  return {
    // Attainment compares the RATIO, not the revenue: a rep whose target was
    // raised mid-year has not gone backwards by closing more, and comparing
    // the numerators alone would say they had.
    attainment: rateDelta(
      'attainment',
      rate(current.fyRevenueMinor, current.revenueTargetMinor),
      rate(prior.fyRevenueMinor, prior.revenueTargetMinor),
      prior.cumulativePeriod,
    ),
    pushEvents: countDelta(
      'pushEvents',
      current.pushEvents,
      prior.pushEvents,
      prior.cumulativePeriod,
    ),
    dealsCreated: countDelta(
      'dealsCreated',
      current.dealsCreated,
      prior.dealsCreated,
      prior.cumulativePeriod,
    ),
    staleOpenDeals: countDelta(
      'staleOpenDeals',
      current.staleOpenDeals,
      prior.staleOpenDeals,
      prior.statePeriod,
    ),
    completeness: rateDelta(
      'completeness',
      rate(current.completenessFilled, current.completenessApplicable),
      rate(prior.completenessFilled, prior.completenessApplicable),
      prior.statePeriod,
    ),
  };
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** '2026-08' → 'Aug 2026'. The label every delta tooltip names its basis with. */
export function periodLabel(period: string | null): string {
  if (!period) return 'no prior period';
  const d = new Date(`${period}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return MONTH_FORMAT.format(d);
}
