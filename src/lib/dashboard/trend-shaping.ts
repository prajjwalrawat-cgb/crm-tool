/**
 * Pure shaping math for the revenue trend chart — weekly bucketing and
 * outlier-aware axis capping.
 *
 * Lives outside the chart component (which is `'use client'` and pulls
 * in Recharts) so the logic is unit-testable from a plain script; see
 * `scripts/selftest-dashboard.ts`. No React, no DB, no env.
 */

/** The daily datum the chart shapes each metric into. */
export type TrendDailyPoint = {
  /** ISO day, yyyy-mm-dd (UTC). */
  day: string;
  /** Primary outcome series — won revenue / won deals. */
  seriesA: number;
  /** "New" series — pipeline created / deals created. */
  seriesB: number;
  /** Secondary outcome series — lost revenue / lost deals. */
  seriesC: number;
};

export type WeeklyPoint = {
  /** ISO date of the week's Monday (UTC). */
  weekStart: string;
  label: string;
  /** True figures — what the tooltip always shows. */
  newPipeline: number;
  won: number;
  lost: number;
  /** Axis-clamped figures — what the geometry is drawn from. */
  newPipelinePlot: number;
  wonPlot: number;
  lostPlot: number;
  newPipelineCapped: boolean;
  outcomeCapped: boolean;
};

export type WeeklyData = {
  points: WeeklyPoint[];
  /** `null` = no capping needed; otherwise the left-axis ceiling. */
  pipelineCap: number | null;
  /** Right-axis ceiling for the won/lost pair. */
  outcomeCap: number | null;
  /**
   * DIAGNOSTIC ONLY — never render these. Axis capping is already
   * communicated to the user where it actually matters: the capped
   * bar draws a torn top edge (`CappedBar`) and the tooltip for that
   * week states the figures shown are the real ones. A second,
   * always-on banner above the chart said the same thing in
   * console-note phrasing and read as leaked debug output.
   *
   * The chart logs these via `console.warn` in development so the
   * capping decision stays observable while working on the shaping
   * math. See `revenue-trend-chart.tsx`.
   */
  devNotices: string[];
};

/** Monday of the ISO week containing `iso`, in UTC. */
export function isoWeekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

/**
 * Outlier rule: if the largest point is more than 3× the median of the
 * non-zero points, clamp the axis at the 95th percentile. Zeros are
 * excluded from the median because a sparse series is mostly zeros —
 * including them would give a median of 0 and flag every point.
 *
 * Fewer than four non-zero points is too little to call anything an
 * outlier, so capping is skipped entirely there. Returns `null` when
 * no capping applies.
 */
export function computeCap(values: number[]): number | null {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (positive.length < 4) return null;
  const median = quantile(positive, 0.5);
  const max = positive[positive.length - 1]!;
  if (median <= 0 || max <= median * 3) return null;
  const cap = Math.max(quantile(positive, 0.95), median);
  return cap < max ? cap : null;
}

/**
 * Fold daily points into ISO weeks and clamp each axis independently.
 *
 * Two axes, not one: a ₹9.5M pipeline-creation day used to squash the
 * won/lost series flat because everything shared a single linear
 * scale. Bars read against the left axis, outcomes against the right.
 *
 * Cumulative mode takes the week's LAST value rather than summing —
 * summing a running total would compound it.
 */
export function buildWeekly(
  points: TrendDailyPoint[],
  cumulative: boolean,
): WeeklyData {
  const byWeek = new Map<string, { won: number; nu: number; lost: number }>();
  for (const p of points) {
    const key = isoWeekStart(p.day);
    const prev = byWeek.get(key);
    if (!prev || cumulative) {
      // Cumulative: overwrite so the last day of the week wins.
      byWeek.set(key, { won: p.seriesA, nu: p.seriesB, lost: p.seriesC });
      continue;
    }
    prev.won += p.seriesA;
    prev.nu += p.seriesB;
    prev.lost += p.seriesC;
  }

  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  const pipelineCap = computeCap(weeks.map(([, v]) => v.nu));
  const outcomeCap = computeCap(weeks.flatMap(([, v]) => [v.won, v.lost]));

  let cappedPipelineWeeks = 0;
  let cappedOutcomeWeeks = 0;

  const shapedWeeks: WeeklyPoint[] = weeks.map(([weekStart, v]) => {
    const newPipelineCapped = pipelineCap !== null && v.nu > pipelineCap;
    const outcomeCapped =
      outcomeCap !== null && (v.won > outcomeCap || v.lost > outcomeCap);
    if (newPipelineCapped) cappedPipelineWeeks += 1;
    if (outcomeCapped) cappedOutcomeWeeks += 1;
    return {
      weekStart,
      label: weekLabel(weekStart),
      newPipeline: v.nu,
      won: v.won,
      lost: v.lost,
      newPipelinePlot: newPipelineCapped ? pipelineCap! : v.nu,
      wonPlot: outcomeCap !== null ? Math.min(v.won, outcomeCap) : v.won,
      lostPlot: outcomeCap !== null ? Math.min(v.lost, outcomeCap) : v.lost,
      newPipelineCapped,
      outcomeCapped,
    };
  });

  const devNotices: string[] = [];
  if (cappedPipelineWeeks > 0) {
    devNotices.push(
      `${cappedPipelineWeeks} week${cappedPipelineWeeks === 1 ? '' : 's'} exceed${cappedPipelineWeeks === 1 ? 's' : ''} the pipeline axis (capped at the 95th percentile so the rest stays readable).`,
    );
  }
  if (cappedOutcomeWeeks > 0) {
    devNotices.push(
      `${cappedOutcomeWeeks} week${cappedOutcomeWeeks === 1 ? '' : 's'} exceed${cappedOutcomeWeeks === 1 ? 's' : ''} the won/lost axis.`,
    );
  }

  return { points: shapedWeeks, pipelineCap, outcomeCap, devNotices };
}

/** Week-start label ("Jun 30"). UTC-pinned — SSR and client must agree. */
export function weekLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
