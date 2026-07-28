import { marginPctToBps } from '@/lib/deals/approval';
import { toMinorUnits } from '@/lib/deals/currency';
import type { PatchDealInput } from '@/lib/deals/schema';

/**
 * Maps a validated `patchDealInput` to the deal columns it should write
 * (pure, shared with its self-test).
 *
 * THE rule: a column appears in the result ONLY when its field was present in
 * the input. Everything else is left for the UPDATE to skip, so a caller that
 * edits one field can never blank a column it never sent. The full-form action
 * has the opposite contract — it writes every column from the payload — and
 * pointing a partial editor at it is what silently nulled unit price,
 * quantity, description, deal type, owner and custom fields on the deal detail
 * page.
 */

export type PreviousDealValues = {
  currency: string;
  unitPriceMinor: number | null;
  quantity: number | null;
};

/** Thrown when a unit-price patch can't be completed from the stored row. */
export class UnitPricingIncompleteError extends Error {
  constructor() {
    super('Set both a per-unit price and a quantity.');
    this.name = 'UnitPricingIncompleteError';
  }
}

export function buildDealColumnPatch(
  d: PatchDealInput,
  previous: PreviousDealValues,
  linkPatch: Record<string, unknown> = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...linkPatch };

  if (d.name !== undefined) patch.name = d.name;
  if (d.expectedCloseDate !== undefined) {
    patch.expectedCloseDate = d.expectedCloseDate;
  }
  if (d.companyName !== undefined) {
    patch.companyNameText = d.companyName?.trim() ? d.companyName.trim() : null;
  }
  if (d.contactName !== undefined) {
    patch.contactNameText = d.contactName?.trim() ? d.contactName.trim() : null;
  }
  if (d.contactEmail !== undefined) {
    patch.contactEmailText = d.contactEmail?.trim()
      ? d.contactEmail.trim()
      : null;
  }
  if (d.ownerId !== undefined) patch.ownerId = d.ownerId;
  if (d.currency !== undefined) patch.currency = d.currency;
  if (d.marginPct !== undefined) patch.marginBps = marginPctToBps(d.marginPct);
  if (d.dealType !== undefined) patch.dealType = d.dealType;
  if (d.amount !== undefined) {
    patch.amountMinor = toMinorUnits(d.amount, d.currency ?? previous.currency);
  }

  // Unit pricing: either side can be patched alone, so fill the other from the
  // stored row and re-derive the amount from the pair. This is the only way
  // amount changes for a unit-priced deal.
  if (d.unitPrice !== undefined || d.quantity !== undefined) {
    const currency = d.currency ?? previous.currency;
    const unitPriceMinor =
      d.unitPrice !== undefined
        ? toMinorUnits(d.unitPrice, currency)
        : previous.unitPriceMinor;
    const quantity = d.quantity !== undefined ? d.quantity : previous.quantity;
    if (unitPriceMinor == null || quantity == null) {
      throw new UnitPricingIncompleteError();
    }
    patch.unitPriceMinor = unitPriceMinor;
    patch.quantity = quantity;
    patch.amountMinor = unitPriceMinor * quantity;
  }

  return patch;
}
