/**
 * Pipeline coverage — open pipeline measured against the quota still
 * left to close.
 *
 * Pure; no React, no DB. Unit-tested from `scripts/selftest-dashboard.ts`.
 *
 * ---------------------------------------------------------------
 * WHY THIS SITS NEXT TO QUOTA ATTAINMENT
 * ---------------------------------------------------------------
 * Attainment answers "how much of the year have we banked?". On its
 * own it cannot answer the question a sales leader asks immediately
 * afterwards — "is there enough in the pipe to finish?". 35% attained
 * is comfortable at 5x coverage and alarming at 1.2x, and attainment
 * reads identically in both.
 *
 * ---------------------------------------------------------------
 * THE TWO NUMBERS ARE DIFFERENT KINDS, DELIBERATELY
 * ---------------------------------------------------------------
 * `openPipelineMinor` is a STOCK as of right now. `gapMinor` is
 * derived from fiscal-year-to-date attainment. Dividing one by the
 * other is the standard construction and is what "3x coverage" means
 * everywhere in sales — but it is not a like-for-like ratio, so the
 * tile that renders it says which window each side came from rather
 * than implying a single one.
 *
 * The 3x rule of thumb: at typical win rates you need roughly three
 * times the remaining gap in open pipeline to actually land it.
 */

export type Coverage =
  /** No revenue target set — there is no gap, so no ratio exists. */
  | { state: 'no-target' }
  /**
   * The target is already closed. Coverage is moot and the division
   * would be by zero; `Infinity` on a tile reads as a bug and `0`
   * reads as a crisis, so this is its own state.
   */
  | { state: 'met' }
  /** A real gap remains. `ratio` is open pipeline ÷ that gap. */
  | {
      state: 'covered';
      ratio: number;
      gapMinor: number;
      /** Pipeline needed to reach the 3x floor. */
      healthyPipelineMinor: number;
      band: CoverageBand;
    };

/**
 * `healthy`   ≥ 3x — enough in the pipe at typical win rates.
 * `thin`      2–3x — closeable, but nothing may slip.
 * `at-risk`   < 2x — the remaining pipeline cannot realistically
 *             cover the gap; the year needs new pipeline, not better
 *             execution on what exists.
 */
export type CoverageBand = 'healthy' | 'thin' | 'at-risk';

/** The conventional floor. Below this, coverage is flagged. */
export const HEALTHY_COVERAGE_MULTIPLE = 3;
/** Below this, coverage is flagged more urgently. */
export const AT_RISK_COVERAGE_MULTIPLE = 2;

export function computeCoverage(input: {
  /** Open (non won/lost) pipeline value right now, minor units. */
  openPipelineMinor: number;
  /** Fiscal-year revenue target, minor units. 0/absent = no target. */
  targetMinor: number | null;
  /** Quota-crediting won revenue so far this fiscal year, minor units. */
  achievedMinor: number;
}): Coverage {
  const { openPipelineMinor, targetMinor, achievedMinor } = input;

  if (!targetMinor || targetMinor <= 0 || !Number.isFinite(targetMinor)) {
    return { state: 'no-target' };
  }

  // Over-attainment floors the gap at zero rather than going negative —
  // a negative gap would flip the ratio's sign and paint a team that
  // beat its number in crisis red.
  const gapMinor = Math.max(0, targetMinor - achievedMinor);
  if (gapMinor === 0) return { state: 'met' };

  const ratio = openPipelineMinor / gapMinor;
  const band: CoverageBand =
    ratio >= HEALTHY_COVERAGE_MULTIPLE
      ? 'healthy'
      : ratio >= AT_RISK_COVERAGE_MULTIPLE
        ? 'thin'
        : 'at-risk';

  return {
    state: 'covered',
    ratio,
    gapMinor,
    healthyPipelineMinor: gapMinor * HEALTHY_COVERAGE_MULTIPLE,
    band,
  };
}

/** "4.99x" — one decimal is the precision this number deserves. */
export function formatCoverageRatio(ratio: number): string {
  return `${ratio.toFixed(1)}x`;
}
