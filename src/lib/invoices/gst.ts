/**
 * GST tax split helpers. Intra-state supply (seller and place-of-supply in the
 * same state) → CGST + SGST, each half the rate. Inter-state → IGST at the full
 * rate. "Place of supply" for goods follows the Ship-to (consignee) party,
 * falling back to the Bill-to (buyer). Client- and server-safe (no DB imports).
 */

/** GST state code = first 2 chars of a GSTIN, when they're digits. */
export function gstStateCode(gstin?: string | null): string | null {
  if (!gstin) return null;
  const code = gstin.trim().slice(0, 2);
  return /^\d{2}$/.test(code) ? code : null;
}

/**
 * A party's GST state code. The explicitly-selected `stateCode` wins (works
 * even for unregistered/B2C parties with no GSTIN); otherwise it's derived
 * from the GSTIN prefix.
 */
export function partyStateCode(
  p?: { stateCode?: string | null; gstin?: string | null } | null,
): string | null {
  if (!p) return null;
  if (p.stateCode && /^\d{2}$/.test(p.stateCode)) return p.stateCode;
  return gstStateCode(p.gstin);
}

export type GstBreakdown =
  | { interState: true; igstRate: number; igstMinor: number }
  | {
      interState: false;
      halfRate: number;
      cgstMinor: number;
      sgstMinor: number;
    };

export function gstBreakdown(args: {
  sellerStateCode?: string | null;
  placeStateCode?: string | null;
  taxRate: number;
  taxMinor: number;
}): GstBreakdown {
  const interState = Boolean(
    args.sellerStateCode &&
      args.placeStateCode &&
      args.sellerStateCode !== args.placeStateCode,
  );

  if (interState) {
    return { interState: true, igstRate: args.taxRate, igstMinor: args.taxMinor };
  }
  // Split so the two halves sum back exactly to taxMinor.
  const cgst = Math.round(args.taxMinor / 2);
  return {
    interState: false,
    halfRate: args.taxRate / 2,
    cgstMinor: cgst,
    sgstMinor: args.taxMinor - cgst,
  };
}
