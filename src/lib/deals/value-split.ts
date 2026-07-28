/**
 * Multi-year TCV split — pure rules, shared by the UI, the server action and
 * the self-test.
 *
 * A deal records ONE amount: the total contract value. When that contract runs
 * across several years, these rows say how the total is spread. They are
 * record-and-report only — `deals.amount_minor` stays the figure the board,
 * forecast and targets read, so adding a split never re-bases an existing
 * number.
 *
 * Contract years, not calendar years: year 1 starts on the contract start date
 * and each later year on the anniversary. A contract starting 01-08-2026 gives
 * Aug 2026–Jul 2027, Aug 2027–Jul 2028, …
 */

export const MAX_CONTRACT_YEARS = 10;

export type SplitRow = {
  /** 1-based contract year. */
  yearIndex: number;
  /** Inclusive 'YYYY-MM-DD'. */
  periodStart: string;
  /** Exclusive 'YYYY-MM-DD' — equals the next year's start. */
  periodEnd: string;
  amountMinor: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Add whole years to a 'YYYY-MM-DD', clamping Feb 29 → Feb 28 in common years. */
export function addYearsISO(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const targetYear = y + years;
  // Feb 29 only exists in leap years; a 29-Feb contract start rolls to 28-Feb.
  const isLeap =
    (targetYear % 4 === 0 && targetYear % 100 !== 0) || targetYear % 400 === 0;
  const day = m === 2 && d === 29 && !isLeap ? 28 : d;
  return `${String(targetYear).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Build `termYears` contract-year rows from a start date, spreading
 * `amountMinor` evenly and giving the remainder to year 1 so the rows always
 * sum to exactly the total (minor units are integers — an even split of
 * ₹10,000 over 3 years cannot be three equal numbers).
 */
export function generateContractYears(
  startISO: string,
  termYears: number,
  amountMinor: number,
): SplitRow[] {
  if (!ISO_DATE.test(startISO)) {
    throw new Error('Contract start must be YYYY-MM-DD');
  }
  const term = Math.floor(termYears);
  if (term < 1 || term > MAX_CONTRACT_YEARS) {
    throw new Error(`Term must be between 1 and ${MAX_CONTRACT_YEARS} years`);
  }

  const total = Math.max(0, Math.round(amountMinor));
  const base = Math.floor(total / term);
  const remainder = total - base * term;

  return Array.from({ length: term }, (_, i) => ({
    yearIndex: i + 1,
    periodStart: addYearsISO(startISO, i),
    periodEnd: addYearsISO(startISO, i + 1),
    amountMinor: i === 0 ? base + remainder : base,
  }));
}

export function sumSplit(rows: Pick<SplitRow, 'amountMinor'>[]): number {
  return rows.reduce((acc, r) => acc + r.amountMinor, 0);
}

export type SplitValidation =
  | { ok: true }
  | { ok: false; message: string; differenceMinor?: number };

/**
 * The split must account for the whole deal — no more, no less. Returning the
 * signed difference lets the UI say "₹3,00,000 short" rather than just "wrong".
 */
export function validateSplit(
  rows: SplitRow[],
  dealAmountMinor: number,
): SplitValidation {
  if (rows.length === 0) {
    return { ok: false, message: 'Add at least one contract year.' };
  }
  if (rows.length > MAX_CONTRACT_YEARS) {
    return {
      ok: false,
      message: `A split can cover at most ${MAX_CONTRACT_YEARS} years.`,
    };
  }

  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isInteger(r.yearIndex) || r.yearIndex < 1) {
      return { ok: false, message: 'Contract years must be numbered from 1.' };
    }
    if (seen.has(r.yearIndex)) {
      return { ok: false, message: `Year ${r.yearIndex} appears twice.` };
    }
    seen.add(r.yearIndex);
    if (!ISO_DATE.test(r.periodStart) || !ISO_DATE.test(r.periodEnd)) {
      return { ok: false, message: 'Each year needs a valid start and end date.' };
    }
    if (r.periodEnd <= r.periodStart) {
      return {
        ok: false,
        message: `Year ${r.yearIndex} ends before it starts.`,
      };
    }
    if (!Number.isInteger(r.amountMinor) || r.amountMinor < 0) {
      return {
        ok: false,
        message: `Year ${r.yearIndex} needs a whole, non-negative amount.`,
      };
    }
  }

  // Years must be 1..n with no gaps — they describe one continuous contract.
  const ordered = [...rows].sort((a, b) => a.yearIndex - b.yearIndex);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.yearIndex !== i + 1) {
      return { ok: false, message: 'Contract years must run 1, 2, 3 … with no gaps.' };
    }
  }

  const total = sumSplit(rows);
  if (total !== dealAmountMinor) {
    return {
      ok: false,
      message:
        total < dealAmountMinor
          ? 'The split is short of the deal amount.'
          : 'The split exceeds the deal amount.',
      differenceMinor: dealAmountMinor - total,
    };
  }

  return { ok: true };
}

/** Contract start = year 1's start; term = number of rows. */
export function splitSummary(
  rows: SplitRow[],
): { startISO: string; termYears: number } | null {
  if (rows.length === 0) return null;
  const first = [...rows].sort((a, b) => a.yearIndex - b.yearIndex)[0]!;
  return { startISO: first.periodStart, termYears: rows.length };
}
