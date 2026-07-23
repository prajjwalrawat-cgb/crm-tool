/**
 * Forecast period math (Module 4) — pure, client- and server-safe. Quarters are
 * fiscal-aligned (3-month blocks starting from the org's fiscal-year start
 * month); months are calendar months. All ranges are half-open [start, end) as
 * ISO 'YYYY-MM-DD' strings, matching how `expected_close_date` (a DATE column)
 * is compared.
 */

export type PeriodMode = 'quarter' | 'month';

export type Period = {
  mode: PeriodMode;
  /** Stable key = period start 'YYYY-MM'. */
  key: string;
  label: string;
  /** Inclusive start date, 'YYYY-MM-DD'. */
  startISO: string;
  /** Exclusive end date, 'YYYY-MM-DD'. */
  endISO: string;
};

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function iso(year: number, month0: number, day: number): string {
  // month0 may overflow (e.g. 12 → next Jan); normalize via Date.UTC.
  const d = new Date(Date.UTC(year, month0, day));
  return d.toISOString().slice(0, 10);
}

function absMonth(year: number, month0: number): number {
  return year * 12 + month0;
}

/** The period-start `YYYY-MM` key for a given absolute month index. */
function keyFromAbs(startAbs: number): string {
  const y = Math.floor(startAbs / 12);
  const m = ((startAbs % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function parseKey(key: string): { year: number; month0: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  if (month0 < 0 || month0 > 11) return null;
  return { year, month0 };
}

/**
 * Build the Period covering the given anchor. `anchorKey` (a 'YYYY-MM' start
 * key) selects a specific period; null → the period containing `now`.
 */
export function resolvePeriod(
  mode: PeriodMode,
  anchorKey: string | null,
  now: Date,
  fiscalStartMonth: number,
): Period {
  const fyStart0 = Math.max(0, Math.min(11, (fiscalStartMonth || 1) - 1));

  let startYear: number;
  let startMonth0: number;

  if (mode === 'month') {
    const anchor = anchorKey ? parseKey(anchorKey) : null;
    startYear = anchor ? anchor.year : now.getUTCFullYear();
    startMonth0 = anchor ? anchor.month0 : now.getUTCMonth();
    return monthPeriod(startYear, startMonth0);
  }

  // Quarter: snap the anchor month to its fiscal-quarter start.
  const anchor = anchorKey ? parseKey(anchorKey) : null;
  const anchorAbs = anchor
    ? absMonth(anchor.year, anchor.month0)
    : absMonth(now.getUTCFullYear(), now.getUTCMonth());
  const blockIndex = Math.floor((anchorAbs - fyStart0) / 3);
  const startAbs = blockIndex * 3 + fyStart0;
  startYear = Math.floor(startAbs / 12);
  startMonth0 = ((startAbs % 12) + 12) % 12;

  // Fiscal quarter number within its fiscal year (Q1..Q4).
  const qOfYear = (((blockIndex % 4) + 4) % 4) + 1;
  return {
    mode: 'quarter',
    key: keyFromAbs(startAbs),
    label: `Q${qOfYear} ${labelYear(startYear, startMonth0, fyStart0)}`,
    startISO: iso(startYear, startMonth0, 1),
    endISO: iso(startYear, startMonth0 + 3, 1),
  };
}

function monthPeriod(year: number, month0: number): Period {
  return {
    mode: 'month',
    key: `${year}-${String(month0 + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month0]} ${year}`,
    startISO: iso(year, month0, 1),
    endISO: iso(year, month0 + 1, 1),
  };
}

/** For a non-Jan fiscal start, the fiscal-year label is the year it starts in. */
function labelYear(startYear: number, startMonth0: number, fyStart0: number): number {
  // If the quarter starts before the fiscal-year boundary within the calendar
  // year, it belongs to the fiscal year that began the previous calendar year.
  return startMonth0 >= fyStart0 ? startYear : startYear - 1;
}

/** Shift a period by `delta` units (±1 = next/prev quarter or month). */
export function shiftPeriod(
  period: Period,
  delta: number,
  fiscalStartMonth: number,
): Period {
  const parsed = parseKey(period.key)!;
  const step = period.mode === 'quarter' ? 3 : 1;
  const nextAbs = absMonth(parsed.year, parsed.month0) + delta * step;
  const y = Math.floor(nextAbs / 12);
  const m = ((nextAbs % 12) + 12) % 12;
  return resolvePeriod(
    period.mode,
    `${y}-${String(m + 1).padStart(2, '0')}`,
    new Date(Date.UTC(y, m, 1)),
    fiscalStartMonth,
  );
}
