/**
 * TCV breakdown — pure rules, shared by the UI, the server action and the
 * self-test.
 *
 * A deal records ONE amount: the total contract value. This describes how that
 * total is made up, across two dimensions:
 *
 *   elements — what the money is for (licence, implementation, AMC, …)
 *   years    — when it falls, as contract years
 *
 * Together they form a grid, and the grid's grand total must equal the deal's
 * amount. It is record-and-report only: `deals.amount_minor` stays the figure
 * the board, forecast and targets read, so a breakdown never re-bases an
 * existing number.
 *
 * Contract years, not calendar years: year 1 starts on the contract start date
 * and each later year on the anniversary. A contract starting 01-08-2026 gives
 * Aug 2026–Jul 2027, Aug 2027–Jul 2028, …
 *
 * `billingType` is the author's intent and drives `generateElementAmounts`. It
 * is deliberately NOT enforced afterwards — a one-off fee invoiced across two
 * years, or support that starts in year 2, are ordinary contracts, and the
 * grid has to be able to say so.
 */

export const MAX_CONTRACT_YEARS = 10;
/** Keeps the grid readable and bounds a single deal's row count. */
export const MAX_ELEMENTS = 12;

export const VALUE_COMPONENTS = [
  'license',
  'implementation',
  'support',
  'amc',
  'training',
  'hardware',
  'other',
] as const;
export type ValueComponent = (typeof VALUE_COMPONENTS)[number];

export const VALUE_COMPONENT_LABELS: Record<ValueComponent, string> = {
  license: 'License',
  implementation: 'Implementation',
  support: 'Support',
  amc: 'AMC',
  training: 'Training',
  hardware: 'Hardware',
  other: 'Other',
};

export const BILLING_TYPES = ['one_time', 'recurring'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  one_time: 'One-time',
  recurring: 'Recurring',
};

/** One cell of the grid: an element's amount in one contract year. */
export type SplitRow = {
  /** 1-based position of the element — its identity within the deal. */
  elementIndex: number;
  component: ValueComponent;
  /** Required when `component` is 'other'; ignored otherwise. */
  componentLabel?: string | null;
  billingType: BillingType;
  /** 1-based contract year. */
  yearIndex: number;
  /** Inclusive 'YYYY-MM-DD'. */
  periodStart: string;
  /** Exclusive 'YYYY-MM-DD' — equals the next year's start. */
  periodEnd: string;
  amountMinor: number;
};

/** An element and its per-year amounts, as the UI edits it. */
export type SplitElement = {
  elementIndex: number;
  component: ValueComponent;
  componentLabel?: string | null;
  billingType: BillingType;
  /** Index 0 = year 1. Length always equals the term. */
  amountsMinor: number[];
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

/** The contract-year windows for a term, oldest first. */
export function contractYearPeriods(
  startISO: string,
  termYears: number,
): { yearIndex: number; periodStart: string; periodEnd: string }[] {
  if (!ISO_DATE.test(startISO)) {
    throw new Error('Contract start must be YYYY-MM-DD');
  }
  const term = Math.floor(termYears);
  if (term < 1 || term > MAX_CONTRACT_YEARS) {
    throw new Error(`Term must be between 1 and ${MAX_CONTRACT_YEARS} years`);
  }
  return Array.from({ length: term }, (_, i) => ({
    yearIndex: i + 1,
    periodStart: addYearsISO(startISO, i),
    periodEnd: addYearsISO(startISO, i + 1),
  }));
}

/**
 * Spread `total` over `slots`, giving the remainder to the first slot so the
 * parts always sum to exactly the total. Minor units are integers — an even
 * split of ₹10,000 over 3 years cannot be three equal numbers.
 */
export function spreadEvenly(total: number, slots: number): number[] {
  const n = Math.max(1, Math.floor(slots));
  const amount = Math.max(0, Math.round(total));
  const base = Math.floor(amount / n);
  const remainder = amount - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + remainder : base));
}

/**
 * The per-year amounts a newly-added or retyped element starts with.
 *
 *   one-time  → the whole amount in year 1, nothing after
 *   recurring → spread evenly across the term
 *
 * A starting point, not a rule: the caller may edit any year afterwards
 * without changing `billingType`.
 */
export function generateElementAmounts(
  billingType: BillingType,
  termYears: number,
  amountMinor: number,
): number[] {
  const term = Math.max(1, Math.floor(termYears));
  const amount = Math.max(0, Math.round(amountMinor));
  if (billingType === 'one_time') {
    return Array.from({ length: term }, (_, i) => (i === 0 ? amount : 0));
  }
  return spreadEvenly(amount, term);
}

/**
 * Seed a breakdown for a deal that doesn't have one yet: a single recurring
 * element carrying the whole value, spread across the term. Keeps the
 * pre-element behaviour as the default, so opening the card on an existing
 * deal shows something meaningful rather than an empty grid.
 */
export function generateDefaultElements(
  termYears: number,
  amountMinor: number,
): SplitElement[] {
  return [
    {
      elementIndex: 1,
      component: 'license',
      componentLabel: null,
      billingType: 'recurring',
      amountsMinor: generateElementAmounts('recurring', termYears, amountMinor),
    },
  ];
}

/** Flatten the edit model into the rows that get stored. */
export function elementsToRows(
  elements: SplitElement[],
  startISO: string,
  termYears: number,
): SplitRow[] {
  const periods = contractYearPeriods(startISO, termYears);
  const rows: SplitRow[] = [];
  for (const el of elements) {
    for (const p of periods) {
      rows.push({
        elementIndex: el.elementIndex,
        component: el.component,
        componentLabel:
          el.component === 'other' ? (el.componentLabel ?? '').trim() : null,
        billingType: el.billingType,
        yearIndex: p.yearIndex,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        amountMinor: el.amountsMinor[p.yearIndex - 1] ?? 0,
      });
    }
  }
  return rows;
}

/** Rebuild the edit model from stored rows. Inverse of `elementsToRows`. */
export function rowsToElements(rows: SplitRow[]): SplitElement[] {
  const byElement = new Map<number, SplitRow[]>();
  for (const r of rows) {
    const list = byElement.get(r.elementIndex) ?? [];
    list.push(r);
    byElement.set(r.elementIndex, list);
  }
  const termYears = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.yearIndex));
  return [...byElement.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([elementIndex, group]) => {
      const first = group[0]!;
      const amountsMinor = Array.from({ length: termYears }, (_, i) => {
        const cell = group.find((g) => g.yearIndex === i + 1);
        return cell ? cell.amountMinor : 0;
      });
      return {
        elementIndex,
        component: first.component,
        componentLabel: first.componentLabel ?? null,
        billingType: first.billingType,
        amountsMinor,
      };
    });
}

/** An element's total across all years. */
export function elementTotal(el: SplitElement): number {
  return el.amountsMinor.reduce((a, b) => a + b, 0);
}

/** Per-year totals across all elements. Index 0 = year 1. */
export function yearTotals(elements: SplitElement[], termYears: number): number[] {
  return Array.from({ length: termYears }, (_, i) =>
    elements.reduce((acc, el) => acc + (el.amountsMinor[i] ?? 0), 0),
  );
}

export function sumSplit(rows: Pick<SplitRow, 'amountMinor'>[]): number {
  return rows.reduce((acc, r) => acc + r.amountMinor, 0);
}

export function sumElements(elements: SplitElement[]): number {
  return elements.reduce((acc, el) => acc + elementTotal(el), 0);
}

/** Display name for an element — the custom label when it has one. */
export function componentDisplayName(
  component: ValueComponent,
  componentLabel?: string | null,
): string {
  if (component === 'other') {
    const trimmed = (componentLabel ?? '').trim();
    return trimmed.length > 0 ? trimmed : 'Other';
  }
  return VALUE_COMPONENT_LABELS[component];
}

export type SplitValidation =
  | { ok: true }
  | { ok: false; message: string; differenceMinor?: number };

/**
 * The breakdown must account for the whole deal — no more, no less. Returning
 * the signed difference lets the UI say "₹3,00,000 short" rather than just
 * "wrong".
 *
 * Note what is deliberately NOT checked: whether a `one_time` element puts
 * money outside year 1. That combination is legitimate (a one-off fee invoiced
 * in two instalments), and `billingType` only seeds the auto-fill.
 */
export function validateSplit(
  rows: SplitRow[],
  dealAmountMinor: number,
): SplitValidation {
  if (rows.length === 0) {
    return { ok: false, message: 'Add at least one element.' };
  }

  for (const r of rows) {
    if (!Number.isInteger(r.elementIndex) || r.elementIndex < 1) {
      return { ok: false, message: 'Elements must be numbered from 1.' };
    }
    if (!Number.isInteger(r.yearIndex) || r.yearIndex < 1) {
      return { ok: false, message: 'Contract years must be numbered from 1.' };
    }
  }

  const elementIndexes = [...new Set(rows.map((r) => r.elementIndex))].sort(
    (a, b) => a - b,
  );
  const yearIndexes = [...new Set(rows.map((r) => r.yearIndex))].sort(
    (a, b) => a - b,
  );

  if (elementIndexes.length > MAX_ELEMENTS) {
    return {
      ok: false,
      message: `A breakdown can have at most ${MAX_ELEMENTS} elements.`,
    };
  }
  if (yearIndexes.length > MAX_CONTRACT_YEARS) {
    return {
      ok: false,
      message: `A breakdown can cover at most ${MAX_CONTRACT_YEARS} years.`,
    };
  }

  // Elements and years both number from 1 with no gaps — together they
  // describe one continuous contract.
  for (let i = 0; i < elementIndexes.length; i++) {
    if (elementIndexes[i] !== i + 1) {
      return {
        ok: false,
        message: 'Elements must be numbered 1, 2, 3 … with no gaps.',
      };
    }
  }
  for (let i = 0; i < yearIndexes.length; i++) {
    if (yearIndexes[i] !== i + 1) {
      return {
        ok: false,
        message: 'Contract years must run 1, 2, 3 … with no gaps.',
      };
    }
  }

  const seen = new Set<string>();
  const elementMeta = new Map<
    number,
    { component: ValueComponent; label: string; billingType: BillingType }
  >();
  const periodByYear = new Map<number, string>();

  for (const r of rows) {
    const key = `${r.elementIndex}:${r.yearIndex}`;
    if (seen.has(key)) {
      return {
        ok: false,
        message: `Element ${r.elementIndex} has two entries for year ${r.yearIndex}.`,
      };
    }
    seen.add(key);

    if (!VALUE_COMPONENTS.includes(r.component)) {
      return { ok: false, message: `"${r.component}" is not a known element.` };
    }
    if (!BILLING_TYPES.includes(r.billingType)) {
      return {
        ok: false,
        message: `"${r.billingType}" is not a known billing type.`,
      };
    }
    const label = (r.componentLabel ?? '').trim();
    if (r.component === 'other' && label.length === 0) {
      return { ok: false, message: 'Name each custom element.' };
    }

    // Every row of an element must agree about what that element is —
    // otherwise year 2 could silently claim to be a different line item.
    const prior = elementMeta.get(r.elementIndex);
    if (!prior) {
      elementMeta.set(r.elementIndex, {
        component: r.component,
        label,
        billingType: r.billingType,
      });
    } else if (
      prior.component !== r.component ||
      prior.label !== label ||
      prior.billingType !== r.billingType
    ) {
      return {
        ok: false,
        message: `Element ${r.elementIndex} describes itself differently in different years.`,
      };
    }

    if (!ISO_DATE.test(r.periodStart) || !ISO_DATE.test(r.periodEnd)) {
      return { ok: false, message: 'Each year needs a valid start and end date.' };
    }
    if (r.periodEnd <= r.periodStart) {
      return { ok: false, message: `Year ${r.yearIndex} ends before it starts.` };
    }
    if (!Number.isInteger(r.amountMinor) || r.amountMinor < 0) {
      return {
        ok: false,
        message: `Element ${r.elementIndex}, year ${r.yearIndex} needs a whole, non-negative amount.`,
      };
    }

    // All rows for a given year must agree on that year's dates.
    const period = `${r.periodStart}|${r.periodEnd}`;
    const priorPeriod = periodByYear.get(r.yearIndex);
    if (priorPeriod && priorPeriod !== period) {
      return {
        ok: false,
        message: `Year ${r.yearIndex} has conflicting start and end dates.`,
      };
    }
    periodByYear.set(r.yearIndex, period);
  }

  // The grid must be complete: every element needs a cell for every year, or
  // the per-year totals would silently under-report.
  if (seen.size !== elementIndexes.length * yearIndexes.length) {
    return {
      ok: false,
      message: 'Every element needs an amount for every contract year.',
    };
  }

  const total = sumSplit(rows);
  if (total !== dealAmountMinor) {
    return {
      ok: false,
      message:
        total < dealAmountMinor
          ? 'The breakdown is short of the deal amount.'
          : 'The breakdown exceeds the deal amount.',
      differenceMinor: dealAmountMinor - total,
    };
  }

  return { ok: true };
}

/** Contract start = year 1's start; term = distinct years; elements = distinct lines. */
export function splitSummary(
  rows: SplitRow[],
): { startISO: string; termYears: number; elementCount: number } | null {
  if (rows.length === 0) return null;
  const first = [...rows].sort((a, b) => a.yearIndex - b.yearIndex)[0]!;
  return {
    startISO: first.periodStart,
    termYears: new Set(rows.map((r) => r.yearIndex)).size,
    elementCount: new Set(rows.map((r) => r.elementIndex)).size,
  };
}
