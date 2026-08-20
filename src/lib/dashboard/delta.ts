/**
 * How a period-over-period change gets described.
 *
 * Pure — no React, no DB, no currency context. Unit-tested from
 * `scripts/selftest-dashboard.ts`; every KPI tile on both dashboards
 * routes through `computeDelta` so no surface can invent its own
 * rounding, its own cap, or its own idea of what a zero baseline means.
 *
 * ---------------------------------------------------------------
 * WHY A PERCENTAGE IS SOMETIMES THE WRONG ANSWER
 * ---------------------------------------------------------------
 * "Weighted pipeline +900%+" is not a statement about the business.
 * It is a statement about the denominator: the prior window held
 * almost nothing, so the ratio is dominated by how close to zero that
 * almost-nothing was. Rendering it as a percentage — capped or not —
 * invites the reader to compare it against other percentages on the
 * same row, where it means something completely different.
 *
 * Three escape hatches, in order of how empty the baseline is:
 *
 *   prior is exactly zero        → `new`      ("New this period")
 *   prior is nearly zero         → `absolute` ("+₹4.2M")
 *   prior is a real number       → `percent`  ("+37%")
 *
 * "Nearly zero" is defined by the OUTCOME, not by the input: if the
 * ratio comes out past {@link ABSURD_PCT_THRESHOLD} the baseline was
 * too small to divide by, whatever its absolute size. That keeps the
 * rule scale-free — it works identically for a ₹40 pipeline and a
 * ₹40,00,00,000 one, and needs no per-metric tuning.
 *
 * Rates are exempt. A win rate moving 40% → 44% is reported in
 * percentage POINTS, which are bounded to ±100 by construction and can
 * never blow up, so `points` never needs an escape hatch.
 */

export type Delta =
  /** No comparable figure exists — render "n/a", not "0%". */
  | { kind: 'none' }
  /** Unchanged (or within the rounding floor). */
  | { kind: 'flat' }
  /** Relative change, safe to render as a percentage. */
  | { kind: 'percent'; pct: number }
  /** Absolute percentage-POINT change, for rates. Always bounded. */
  | { kind: 'points'; points: number }
  /** Grew from an exactly-zero baseline. There is no percentage. */
  | { kind: 'new' }
  /**
   * Baseline was too near zero for a ratio to inform. `change` is
   * `current - prior` in the metric's own units; the caller formats it
   * (money, days, count) since only the caller knows which.
   */
  | { kind: 'absolute'; change: number };

/**
 * Past this magnitude a percentage stops describing the numerator and
 * starts describing the denominator. 500% = a six-fold change; beyond
 * that the reader is better served by the absolute figure.
 *
 * Deliberately well below the old 999% display cap. Capping at 999
 * still rendered "+900%+" — a number shaped like a measurement but
 * carrying none of the information one implies.
 */
export const ABSURD_PCT_THRESHOLD = 500;

/**
 * Changes smaller than this (in percent, or in points) read as noise
 * and render as "flat" rather than "+0.0%".
 */
export const FLAT_EPSILON = 0.05;

/**
 * Describe `current` relative to `prior` as a relative change.
 *
 * `prior` is the same measure over the immediately preceding window of
 * equal length — never a different metric, never a different span.
 */
export function computeDelta(current: number, prior: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) {
    return { kind: 'none' };
  }
  if (current === prior) return { kind: 'flat' };

  if (prior === 0) {
    // Something from nothing. A percentage would be infinite; the
    // honest report is that the metric only exists in this window.
    // A move DOWN to a negative value from zero has no "new" reading,
    // so it falls through to the absolute change.
    return current > 0 ? { kind: 'new' } : { kind: 'absolute', change: current };
  }

  const pct = ((current - prior) / Math.abs(prior)) * 100;
  if (Math.abs(pct) < FLAT_EPSILON) return { kind: 'flat' };
  if (Math.abs(pct) > ABSURD_PCT_THRESHOLD) {
    return { kind: 'absolute', change: current - prior };
  }
  return { kind: 'percent', pct };
}

/**
 * Describe a change in a RATE (win rate, attainment, conversion) as
 * percentage points. `current` and `prior` are ratios in 0–1.
 *
 * Points are already an absolute difference, so there is no baseline
 * to divide by and no blow-up to guard against.
 */
export function computePointsDelta(current: number, prior: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) {
    return { kind: 'none' };
  }
  const points = (current - prior) * 100;
  if (Math.abs(points) < FLAT_EPSILON) return { kind: 'flat' };
  return { kind: 'points', points };
}

/** Direction for the arrow glyph. `null` when there's nothing to point at. */
export function deltaDirection(delta: Delta): 'up' | 'down' | null {
  switch (delta.kind) {
    case 'new':
      return 'up';
    case 'percent':
      return delta.pct > 0 ? 'up' : 'down';
    case 'points':
      return delta.points > 0 ? 'up' : 'down';
    case 'absolute':
      return delta.change > 0 ? 'up' : 'down';
    default:
      return null;
  }
}

/**
 * Short text for the delta chip.
 *
 * `formatAbsolute` renders a raw change in the metric's own units and
 * MUST include its own sign handling for negatives — it receives the
 * signed value. Money callers pass a currency formatter; a day-count
 * caller passes something like `(n) => `${n}d``.
 */
export function formatDelta(
  delta: Delta,
  formatAbsolute: (change: number) => string,
): string {
  switch (delta.kind) {
    case 'none':
      return 'n/a';
    case 'flat':
      return 'flat';
    case 'new':
      return 'New this period';
    case 'absolute': {
      const sign = delta.change > 0 ? '+' : '−';
      return `${sign}${formatAbsolute(Math.abs(delta.change))}`;
    }
    case 'points': {
      const m = Math.abs(delta.points);
      return `${m.toFixed(1)} pts`;
    }
    case 'percent': {
      const m = Math.abs(delta.pct);
      return `${m.toFixed(m < 10 ? 1 : 0)}%`;
    }
  }
}

/**
 * Long-form text for the chip's tooltip — always states the comparison
 * basis, because "+37%" against an unnamed prior period is exactly the
 * ambiguity this whole pass exists to remove.
 */
export function describeDelta(
  delta: Delta,
  priorLabel: string,
  formatAbsolute: (change: number) => string,
): string {
  const basis = `vs the prior ${priorLabel.toLowerCase()}`;
  switch (delta.kind) {
    case 'none':
      return `No comparable figure ${basis}.`;
    case 'flat':
      return `Unchanged ${basis}.`;
    case 'new':
      return `Nothing to compare — this metric was zero ${basis}, so there is no percentage to report.`;
    case 'absolute': {
      const sign = delta.change > 0 ? '+' : '−';
      return `${sign}${formatAbsolute(Math.abs(delta.change))} ${basis}. Shown as an absolute change because the prior figure was too near zero for a percentage to mean anything.`;
    }
    case 'points': {
      const sign = delta.points > 0 ? '+' : '−';
      return `${sign}${Math.abs(delta.points).toFixed(1)} percentage points ${basis}.`;
    }
    case 'percent': {
      const sign = delta.pct > 0 ? '+' : '−';
      return `${sign}${Math.abs(delta.pct).toFixed(1)}% ${basis}.`;
    }
  }
}
