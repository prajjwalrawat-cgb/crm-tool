/**
 * Money helpers. Amounts are persisted as integer minor units (paise) to
 * avoid floating-point drift; the UI works in major units (rupees).
 */

export function rupeesToMinor(rupees: number): number {
  return Math.round(rupees * 100);
}

export function minorToRupees(minor: number): number {
  return minor / 100;
}

export function formatMoneyMinor(minor: number, currency = 'INR'): string {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(minor / 100);
  } catch {
    // Unknown currency code — fall back to a plain number.
    return (minor / 100).toFixed(2);
  }
}

/** Compute per-line amounts and the header totals, all in minor units. */
export function computeTotals(
  items: { quantity: number; rate: number }[],
  taxRatePercent: number,
): {
  amountsMinor: number[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
} {
  const amountsMinor = items.map((it) =>
    Math.round(it.quantity * rupeesToMinor(it.rate)),
  );
  const subtotalMinor = amountsMinor.reduce((s, a) => s + a, 0);
  const taxMinor = Math.round((subtotalMinor * taxRatePercent) / 100);
  return {
    amountsMinor,
    subtotalMinor,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
  };
}
