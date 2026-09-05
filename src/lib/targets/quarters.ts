/**
 * FISCAL QUARTERS AND PACE — the two things a yearly target can't say on
 * its own.
 *
 * `./fiscal` answers "which window is FY2026?". This module answers the
 * two questions that follow once a manager is looking at 41% attainment:
 *
 *   1. WHERE did it come from? Four quarter windows that partition the
 *      fiscal year exactly, so quarterly figures sum back to the annual
 *      one instead of approximately agreeing with it.
 *   2. Is 41% GOOD? Only relative to how much of the year has gone. 41%
 *      in month five is ahead; 41% in month eleven is a miss being
 *      discovered too late. `pace()` is that comparison, and it is the
 *      closest honest reading of "commitment to the target" the data
 *      supports — see the note on PACE below.
 *
 * Pure + client-safe (no DB, no `server-only`): the scorecard renders
 * these on the server and the self-test drives them directly.
 *
 * ---------------------------------------------------------------
 * QUARTERLY TARGETS ARE DERIVED, NOT STORED
 * ---------------------------------------------------------------
 * `sales_targets` carries one annual revenue figure per rep. There is no
 * per-quarter column, so a quarterly target here is the annual one split
 * four ways — a straight line, which is NOT how most sales years actually
 * land (Q4 usually carries more). The split is therefore labelled as
 * derived everywhere it is rendered rather than presented as something an
 * admin set. If per-quarter targets are wanted later they belong in the
 * table, not in an inferred curve here.
 *
 * The remainder from dividing by four is given to Q4 rather than dropped,
 * so the four quarters sum to the annual target to the minor unit.
 */

const MS_PER_DAY = 86_400_000;
/** Mean days per month over a year — used only for run-rate arithmetic. */
const DAYS_PER_MONTH = 365 / 12;

export type FiscalQuarter = {
  /** 1–4, in fiscal order (Q1 starts the fiscal year, not January). */
  index: 1 | 2 | 3 | 4;
  /** "Q1" … "Q4". */
  label: string;
  /** Inclusive start (UTC midnight). */
  start: Date;
  /** Exclusive end (UTC midnight). */
  end: Date;
};

/**
 * The four quarter windows of a fiscal year, half-open like
 * `fiscalYearRange` — so consecutive quarters partition the year with
 * nothing counted twice and nothing falling between them. That property is
 * what lets quarterly revenue sum back to the annual figure.
 */
export function fiscalQuarters(
  startMonth: number,
  fiscalYear: number,
): FiscalQuarter[] {
  return ([1, 2, 3, 4] as const).map((index) => {
    const monthOffset = (index - 1) * 3;
    const start = new Date(
      Date.UTC(fiscalYear, startMonth - 1 + monthOffset, 1),
    );
    const end = new Date(
      Date.UTC(fiscalYear, startMonth - 1 + monthOffset + 3, 1),
    );
    return { index, label: `Q${index}`, start, end };
  });
}

/**
 * Which fiscal quarter a moment falls in, or null when it is outside the
 * fiscal year entirely. Used to place "now" on the quarter strip.
 */
export function quarterIndexOf(
  startMonth: number,
  fiscalYear: number,
  at: Date,
): 1 | 2 | 3 | 4 | null {
  for (const q of fiscalQuarters(startMonth, fiscalYear)) {
    if (at >= q.start && at < q.end) return q.index;
  }
  return null;
}

/**
 * Straight-line quarterly split of an annual target, with the division
 * remainder given to Q4 so the four values sum to `annualMinor` exactly.
 * Returns [q1, q2, q3, q4].
 */
export function splitAnnualTarget(
  annualMinor: number,
): [number, number, number, number] {
  const base = Math.floor(annualMinor / 4);
  return [base, base, base, annualMinor - base * 3];
}

/** How much of a window has elapsed at `now`, clamped to 0–1. */
export function elapsedFraction(start: Date, end: Date, now: Date): number {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
}

/* ---------------------------------------------------------------
 * PACE
 * ---------------------------------------------------------------
 * The ratio below is attainment divided by elapsed time. It is a
 * SCHEDULE measure, not a measure of effort or intent: a rep whose
 * whole year lands in Q4 reads "behind" until it does. That is why the
 * bands are wide, why the tile shows the two inputs (attained, expected)
 * next to the verdict rather than only a colour, and why nothing here
 * pretends to be a "commitment score" — the honest reading is "against a
 * straight line, this rep is X". Pipeline coverage (see
 * `@/lib/dashboard/coverage`) is the other half of that conversation and
 * is deliberately kept a separate number.
 */

/** At or above this multiple of the straight line, a rep is ahead. */
export const PACE_AHEAD_RATIO = 1.05;
/** At or above this, on track. Below `PACE_BEHIND_RATIO`, at risk. */
export const PACE_ON_TRACK_RATIO = 0.9;
export const PACE_BEHIND_RATIO = 0.7;

export type PaceStatus = 'ahead' | 'on-track' | 'behind' | 'at-risk';

export type Pace =
  /** No annual target set — there is no line to be ahead of. */
  | { state: 'no-target' }
  /** The fiscal year hasn't started; every rep would read as 0% of 0%. */
  | { state: 'not-started' }
  | {
      state: 'tracked';
      /** 0–1 of the fiscal year gone. */
      elapsed: number;
      /** Target × elapsed — where a straight line would have this rep by now. */
      expectedMinor: number;
      /** Achieved − expected. Negative is behind. */
      varianceMinor: number;
      /** Achieved ÷ expected. 1.0 is exactly on the line. */
      ratio: number;
      status: PaceStatus;
      /** Target still to close. Floored at 0. */
      gapMinor: number;
      /**
       * What the gap works out to per remaining month. Null once the year
       * is over — the number would be a division by (nearly) zero and
       * reads as a wild figure on a card rather than as "time is up".
       */
      requiredPerMonthMinor: number | null;
      /** Months left in the fiscal year, fractional. */
      monthsLeft: number;
    };

export function pace(input: {
  achievedMinor: number;
  targetMinor: number;
  fyStart: Date;
  fyEnd: Date;
  now: Date;
}): Pace {
  const { achievedMinor, targetMinor, fyStart, fyEnd, now } = input;
  if (!targetMinor || targetMinor <= 0 || !Number.isFinite(targetMinor)) {
    return { state: 'no-target' };
  }
  if (now < fyStart) return { state: 'not-started' };

  const elapsed = elapsedFraction(fyStart, fyEnd, now);
  const expectedMinor = Math.round(targetMinor * elapsed);
  // A year one day old has an expected figure near zero, and dividing by
  // it yields a ratio in the thousands. Treat the first stretch of the
  // year as unrankable rather than crowning whoever closed first.
  const ratio = expectedMinor > 0 ? achievedMinor / expectedMinor : 1;
  const status: PaceStatus =
    ratio >= PACE_AHEAD_RATIO
      ? 'ahead'
      : ratio >= PACE_ON_TRACK_RATIO
        ? 'on-track'
        : ratio >= PACE_BEHIND_RATIO
          ? 'behind'
          : 'at-risk';

  const gapMinor = Math.max(0, targetMinor - achievedMinor);
  const daysLeft = Math.max(0, (fyEnd.getTime() - now.getTime()) / MS_PER_DAY);
  const monthsLeft = daysLeft / DAYS_PER_MONTH;
  return {
    state: 'tracked',
    elapsed,
    expectedMinor,
    varianceMinor: achievedMinor - expectedMinor,
    ratio,
    status,
    gapMinor,
    requiredPerMonthMinor:
      monthsLeft >= 0.25 ? Math.round(gapMinor / monthsLeft) : null,
    monthsLeft,
  };
}

export const PACE_STATUS_LABELS: Record<PaceStatus, string> = {
  ahead: 'Ahead of pace',
  'on-track': 'On pace',
  behind: 'Behind pace',
  'at-risk': 'At risk',
};

/**
 * One line of plain English under the verdict. `formatMoney` is injected
 * so this module stays currency-context-free, the same contract
 * `deweightedNote` and friends use.
 */
export function paceNote(
  p: Pace,
  formatMoney: (minor: number) => string,
): string | null {
  if (p.state === 'no-target') return 'No revenue target set for this year';
  if (p.state === 'not-started') return 'Fiscal year has not started yet';
  const elapsedPct = Math.round(p.elapsed * 100);
  const side =
    p.varianceMinor >= 0
      ? `${formatMoney(p.varianceMinor)} ahead of`
      : `${formatMoney(-p.varianceMinor)} behind`;
  return `${elapsedPct}% of the year gone — ${side} a straight line`;
}
