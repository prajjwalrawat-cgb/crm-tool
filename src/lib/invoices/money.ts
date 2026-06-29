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

/**
 * Compute per-line amounts and the header totals, all in minor units.
 * Shipping (freight) is an optional separately-taxed charge: `subtotalMinor`
 * stays items-only, `taxMinor` is items-tax + shipping-tax, and `totalMinor`
 * is items + shipping + total tax.
 */
export function computeTotals(
  items: { quantity: number; rate: number }[],
  taxRatePercent: number,
  shipping?: { amount: number; taxRatePercent: number },
): {
  amountsMinor: number[];
  subtotalMinor: number;
  itemsTaxMinor: number;
  shippingMinor: number;
  shippingTaxMinor: number;
  taxMinor: number;
  totalMinor: number;
} {
  const amountsMinor = items.map((it) =>
    Math.round(it.quantity * rupeesToMinor(it.rate)),
  );
  const subtotalMinor = amountsMinor.reduce((s, a) => s + a, 0);
  const itemsTaxMinor = Math.round((subtotalMinor * taxRatePercent) / 100);

  const shippingMinor = shipping ? rupeesToMinor(shipping.amount) : 0;
  const shippingTaxMinor = Math.round(
    (shippingMinor * (shipping?.taxRatePercent ?? 0)) / 100,
  );

  const taxMinor = itemsTaxMinor + shippingTaxMinor;
  return {
    amountsMinor,
    subtotalMinor,
    itemsTaxMinor,
    shippingMinor,
    shippingTaxMinor,
    taxMinor,
    totalMinor: subtotalMinor + shippingMinor + taxMinor,
  };
}
