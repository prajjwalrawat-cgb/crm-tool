/**
 * Quote totals — pure integer money maths (paise + basis points), no DB.
 * The server recomputes with this on every save; client totals are display-only.
 */

export type QuoteLineInput = { quantity: number; rateMinor: number; discountBps: number; taxRateBps: number };
export type OverallDiscount = { type: 'none' } | { type: 'amount'; valueMinor: number } | { type: 'percent'; bps: number };
export type QuoteLineTotals = {
  grossMinor: number;
  lineDiscountMinor: number;
  amountMinor: number;
  allocatedDiscountMinor: number;
  taxableMinor: number;
  taxMinor: number;
};
export type TaxGroup = { rateBps: number; taxableMinor: number; taxMinor: number };
export type QuoteTotals = {
  lines: QuoteLineTotals[];
  subtotalMinor: number;
  lineDiscountMinor: number;
  overallDiscountMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxGroups: TaxGroup[];
  taxMinor: number;
  totalMinor: number;
};

export class QuoteTotalsError extends Error {
  code: 'discount_exceeds_subtotal' | 'invalid_input';
  constructor(code: 'discount_exceeds_subtotal' | 'invalid_input', message: string) {
    super(message);
    this.name = 'QuoteTotalsError';
    this.code = code;
  }
}

const MAX_DISCOUNT_BPS = 10_000;
const MAX_TAX_BPS = 4_000;

function invalid(message: string): never {
  throw new QuoteTotalsError('invalid_input', message);
}

function bpsIn(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) invalid(`${label} must be an integer 0..${max}`);
}

/** round(a × bps / 10000), half up, exact for large integers. */
function bpsOf(a: number, bps: number): number {
  return Number((BigInt(a) * BigInt(bps) * BigInt(2) + BigInt(10_000)) / BigInt(20_000));
}

export function computeQuoteTotals(lines: QuoteLineInput[], overall: OverallDiscount): QuoteTotals {
  for (const l of lines) {
    if (!Number.isFinite(l.quantity) || l.quantity < 0) invalid('quantity must be a non-negative number');
    if (!Number.isInteger(l.rateMinor) || l.rateMinor < 0) invalid('rateMinor must be a non-negative integer');
    bpsIn(l.discountBps, MAX_DISCOUNT_BPS, 'discountBps');
    bpsIn(l.taxRateBps, MAX_TAX_BPS, 'taxRateBps');
  }

  const base = lines.map((l) => {
    const grossMinor = Math.round(l.quantity * l.rateMinor);
    if (!Number.isSafeInteger(grossMinor)) invalid('line amount is too large');
    const lineDiscountMinor = bpsOf(grossMinor, l.discountBps);
    return { grossMinor, lineDiscountMinor, amountMinor: grossMinor - lineDiscountMinor };
  });
  const amountSum = base.reduce((s, b) => s + b.amountMinor, 0);
  if (!Number.isSafeInteger(amountSum)) invalid('quote total is too large');

  let overallDiscountMinor = 0;
  if (overall.type === 'amount') {
    if (!Number.isInteger(overall.valueMinor) || overall.valueMinor < 0) invalid('overall discount amount must be a non-negative integer');
    overallDiscountMinor = overall.valueMinor;
  } else if (overall.type === 'percent') {
    bpsIn(overall.bps, MAX_DISCOUNT_BPS, 'overall discount bps');
    overallDiscountMinor = bpsOf(amountSum, overall.bps);
  }
  if (overallDiscountMinor > amountSum) {
    throw new QuoteTotalsError('discount_exceeds_subtotal', 'Overall discount exceeds the discounted line total');
  }

  // Proportional allocation. The floor remainder is handed out 1 paise at a time over
  // lines in descending amount order (earlier line first on a tie), never beyond a
  // line's own amount, so no line's taxable value goes negative.
  const allocated = base.map((b) =>
    amountSum > 0 && b.amountMinor > 0 ? Number((BigInt(overallDiscountMinor) * BigInt(b.amountMinor)) / BigInt(amountSum)) : 0,
  );
  let remainder = overallDiscountMinor - allocated.reduce((s, a) => s + a, 0);
  const order = base.map((_, i) => i).sort((x, y) => base[y].amountMinor - base[x].amountMinor || x - y);
  while (remainder > 0) {
    for (const i of order) {
      if (remainder > 0 && allocated[i] < base[i].amountMinor) {
        allocated[i] += 1;
        remainder -= 1;
      }
    }
  }

  const lineTotals: QuoteLineTotals[] = base.map((b, i) => {
    const taxableMinor = b.amountMinor - allocated[i];
    return {
      ...b,
      allocatedDiscountMinor: allocated[i],
      taxableMinor,
      taxMinor: bpsOf(taxableMinor, lines[i].taxRateBps),
    };
  });

  const groups = new Map<number, TaxGroup>();
  lineTotals.forEach((l, i) => {
    const rateBps = lines[i].taxRateBps;
    const g = groups.get(rateBps) ?? { rateBps, taxableMinor: 0, taxMinor: 0 };
    g.taxableMinor += l.taxableMinor;
    g.taxMinor += l.taxMinor;
    groups.set(rateBps, g);
  });
  const taxGroups = [...groups.values()].filter((g) => g.taxableMinor !== 0).sort((a, b) => a.rateBps - b.rateBps);

  const sum = (f: (l: QuoteLineTotals) => number) => lineTotals.reduce((s, l) => s + f(l), 0);
  const lineDiscountMinor = sum((l) => l.lineDiscountMinor);
  const taxableMinor = sum((l) => l.taxableMinor);
  const taxMinor = sum((l) => l.taxMinor);
  const subtotalMinor = sum((l) => l.grossMinor);
  if (![subtotalMinor, taxableMinor, taxMinor, taxableMinor + taxMinor].every(Number.isSafeInteger)) invalid('quote total is too large');
  return {
    lines: lineTotals,
    subtotalMinor,
    lineDiscountMinor,
    overallDiscountMinor,
    discountMinor: lineDiscountMinor + overallDiscountMinor,
    taxableMinor,
    taxGroups,
    taxMinor,
    totalMinor: taxableMinor + taxMinor,
  };
}
