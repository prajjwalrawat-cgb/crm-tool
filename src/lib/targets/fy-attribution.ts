/**
 * FISCAL-YEAR ATTRIBUTION — how much of a won deal's TCV belongs to the
 * fiscal year being looked at.
 *
 * ---------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------
 * `targetAchievement` credited the whole of `deals.amount_minor` to
 * whichever fiscal year the deal CLOSED in. A deal is one row carrying
 * one number — the total contract value — so a two-year contract signed
 * in July 2026 put 100% of its value against the 2026 target.
 *
 * In CGB Solutions that inflated one rep's FY2026 attainment from 63% to
 * 77%: ₹58,95,004 of the ₹3,09,41,123 shown as achieved is revenue that
 * lands in 2027 and 2028.
 *
 * ---------------------------------------------------------------
 * WHAT REPLACES IT
 * ---------------------------------------------------------------
 * `deal_value_splits` (migrations 0055/0057) already records the
 * breakdown: one row per (element × contract year), each with a real
 * `[period_start, period_end)` window, guaranteed by `validateSplit` to
 * sum to the deal's amount. This module attributes those rows to a
 * fiscal window by DATE OVERLAP.
 *
 * Contract years are anniversary-based, not calendar-based — a contract
 * starting 01-07-2026 has its first year run to 30-06-2027 — so a
 * contract year routinely straddles two fiscal years. Assigning a whole
 * contract year to whichever fiscal year it starts in would reproduce the
 * original bug one level down. Instead each row contributes
 *
 *     amount × overlap_days / period_days
 *
 * Both windows are half-open, [start, end), so the day counts of two
 * adjacent fiscal years partition the contract year exactly: nothing is
 * counted twice and nothing falls between them.
 *
 * ---------------------------------------------------------------
 * WHAT IS DELIBERATELY *NOT* CHANGED
 * ---------------------------------------------------------------
 * `deals.amount_minor` stays the TCV, and every other surface — board,
 * forecast, pipeline, executive dashboard, reports — keeps reading it
 * unchanged. Targets now reports BOTH figures side by side rather than
 * swapping one for the other: TCV won is what the team sold, fiscal-year
 * revenue is what this year's target measures, and a manager needs to see
 * the difference rather than be handed one number labelled the other.
 *
 * ---------------------------------------------------------------
 * DEALS WITH NO BREAKDOWN
 * ---------------------------------------------------------------
 * Most won deals pre-date the breakdown feature and have no split rows.
 * Those are treated as single-year — full TCV in the close year, i.e.
 * exactly the old behaviour — because the alternative (attributing zero)
 * would understate attainment far more badly than the bug being fixed.
 *
 * That is an ASSUMPTION, not a fact, and it is never applied silently:
 * every caller returns the count of deals it was applied to so the UI can
 * say so out loud. See `splitCoverageNote`.
 *
 * Pure + client-safe apart from the two SQL builders, which take bound
 * parameters and are the ONLY place the overlap rule is written for
 * Postgres. `selftest-target-fy-attribution` runs the JS and the SQL over
 * the same rows and asserts they agree, so the two cannot drift.
 */

import { sql, type SQL } from 'drizzle-orm';

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for a Date, read in UTC — matches how `date` columns compare. */
export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Whole days between two `YYYY-MM-DD` values (b − a). May be negative. */
function daysBetween(aISO: string, bISO: string): number {
  return Math.round(
    (Date.parse(`${bISO}T00:00:00Z`) - Date.parse(`${aISO}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/**
 * Days shared by two half-open date windows, floored at 0.
 *
 * Half-open is what makes fiscal years partition rather than overlap: a
 * contract year [2026-07-01, 2027-07-01) contributes 184 days to
 * [2026-01-01, 2027-01-01) and 181 to [2027-01-01, 2028-01-01) — 365
 * total, the whole year, counted once.
 */
export function overlapDays(
  aStartISO: string,
  aEndISO: string,
  bStartISO: string,
  bEndISO: string,
): number {
  const start = aStartISO > bStartISO ? aStartISO : bStartISO;
  const end = aEndISO < bEndISO ? aEndISO : bEndISO;
  return Math.max(0, daysBetween(start, end));
}

/**
 * The fraction of one split row's amount that falls inside a window.
 * Returns 0 for a degenerate period rather than dividing by zero —
 * `validateSplit` rejects `period_end <= period_start` on write, so this
 * only guards rows that pre-date that check.
 */
export function overlapFraction(
  periodStartISO: string,
  periodEndISO: string,
  windowStartISO: string,
  windowEndISO: string,
): number {
  const periodDays = daysBetween(periodStartISO, periodEndISO);
  if (periodDays <= 0) return 0;
  return (
    overlapDays(periodStartISO, periodEndISO, windowStartISO, windowEndISO) / periodDays
  );
}

/** One split row, reduced to what attribution needs. */
export type AttributableRow = {
  periodStart: string;
  periodEnd: string;
  amountMinor: number;
};

export type FiscalAttribution = {
  /** Unrounded minor units falling inside the fiscal window. */
  inFyMinor: number;
  /** Unrounded minor units falling before it. */
  priorMinor: number;
  /** Unrounded minor units falling after it. */
  futureMinor: number;
};

/**
 * Split a deal's breakdown across (before | inside | after) a fiscal
 * window. Unrounded on purpose — the caller decides where to round, and
 * rounding each bucket independently is what stops the three summing back
 * to the deal.
 *
 * `dealAmountMinor` is the fallback for a deal with no breakdown rows: the
 * whole TCV lands in the fiscal year (see the module note).
 */
export function attributeToFiscalYear(
  rows: AttributableRow[],
  fyStartISO: string,
  fyEndISO: string,
  dealAmountMinor: number,
): FiscalAttribution {
  if (rows.length === 0) {
    return { inFyMinor: dealAmountMinor, priorMinor: 0, futureMinor: 0 };
  }
  let inFy = 0;
  let prior = 0;
  let total = 0;
  for (const r of rows) {
    total += r.amountMinor;
    inFy +=
      r.amountMinor * overlapFraction(r.periodStart, r.periodEnd, fyStartISO, fyEndISO);
    // Everything strictly before the window opens. Uncommon but real: a
    // deal closed inside FY2026 whose contract began in 2025.
    prior +=
      r.amountMinor *
      overlapFraction(r.periodStart, r.periodEnd, '0001-01-01', fyStartISO);
  }
  return { inFyMinor: inFy, priorMinor: prior, futureMinor: total - inFy - prior };
}

/* ---------------------------------------------------------------
 * The same rule, for Postgres
 * --------------------------------------------------------------- */

/**
 * Per-deal minor units falling inside [fyStart, fyEnd), as an unrounded
 * `numeric`. Written against a `deal_value_splits s` in scope.
 *
 * `date - date` in Postgres yields whole days, the same integer
 * `daysBetween` computes above. NULLIF guards the degenerate period the
 * JS returns 0 for.
 */
export function splitPortionInWindowSql(fyStartISO: string, fyEndISO: string): SQL {
  return sql`COALESCE(SUM(
    s.amount_minor::numeric
    * GREATEST(
        0,
        LEAST(s.period_end, ${fyEndISO}::date) - GREATEST(s.period_start, ${fyStartISO}::date)
      )::numeric
    / NULLIF(s.period_end - s.period_start, 0)::numeric
  ), 0)`;
}

/** Per-deal minor units falling strictly before `fyStart`. */
export function splitPortionBeforeSql(fyStartISO: string): SQL {
  return sql`COALESCE(SUM(
    s.amount_minor::numeric
    * GREATEST(0, LEAST(s.period_end, ${fyStartISO}::date) - s.period_start)::numeric
    / NULLIF(s.period_end - s.period_start, 0)::numeric
  ), 0)`;
}

/* ---------------------------------------------------------------
 * Disclosures
 * --------------------------------------------------------------- */

/**
 * The one-line warning shown when fiscal-year revenue rests on the
 * single-year assumption for some of the deals behind it.
 *
 * Null when every counted deal has a breakdown — then the number is
 * derived, not assumed, and the card should stay quiet.
 */
export function splitCoverageNote(
  splitlessCount: number,
  wonCount: number,
): string | null {
  if (splitlessCount <= 0 || wonCount <= 0) return null;
  return `${splitlessCount} of ${wonCount} won ${
    wonCount === 1 ? 'deal has' : 'deals have'
  } no revenue breakdown — counted in full against this year`;
}

/**
 * The one-line warning for margin.
 *
 * Margin value is `amount × margin_bps`, and `margin_bps` is NULL on every
 * deal closed before margin became mandatory. NULL contributes nothing to
 * the sum, so the margin bar silently reads as though those deals were
 * sold at zero margin — indistinguishable, on screen, from a rep who
 * genuinely gave the margin away.
 *
 * Nothing is invented to fix that: the figure stays exactly what it was,
 * and this states how much of the cohort it actually covers. See
 * `targetAchievement` for why the arithmetic was left alone.
 */
export function marginCoverageNote(
  missingCount: number,
  wonCount: number,
): string | null {
  if (missingCount <= 0 || wonCount <= 0) return null;
  return `Margin not recorded on ${missingCount} of ${wonCount} won ${
    wonCount === 1 ? 'deal' : 'deals'
  } — those count as zero margin, not as missing`;
}
