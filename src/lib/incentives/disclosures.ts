/**
 * Plain-language disclosures for computed actuals: what the nightly job left
 * out, and why. Shown wherever computed figures are shown.
 *
 * Pure + client-safe.
 */

type Details = Partial<{
  countedDeals: number;
  splitlessDeals: number;
  untaggedDeals: number;
  untaggedRevenueCr: string;
  nonInrDeals: number;
  marginUnknownDeals: number;
  marginUnknownRevenueCr: string;
  pendingApprovalDeals: number;
}>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function computedActualsNotes(details: Record<string, unknown> | null | undefined): string[] {
  const d = (details ?? {}) as Details;
  const notes: string[] = [];
  if (d.untaggedDeals) {
    notes.push(
      `${plural(d.untaggedDeals, 'won deal')} this FY ${d.untaggedDeals === 1 ? 'has' : 'have'} no close date, so ${d.untaggedDeals === 1 ? 'it' : 'they'} can't be classed as prior-year or net-new and ${d.untaggedDeals === 1 ? 'is' : 'are'} excluded.`,
    );
  }
  if (d.nonInrDeals) {
    notes.push(`${plural(d.nonInrDeals, 'deal')} not in INR ${d.nonInrDeals === 1 ? 'is' : 'are'} excluded — the plan is in ₹ and there's no exchange rate to convert with.`);
  }
  if (d.marginUnknownDeals) {
    notes.push(
      `${plural(d.marginUnknownDeals, 'deal')} with no margin recorded ${d.marginUnknownDeals === 1 ? 'counts' : 'count'} toward revenue but ${d.marginUnknownDeals === 1 ? 'is' : 'are'} left out of the blended margin (₹${Number(d.marginUnknownRevenueCr ?? 0).toFixed(2)} Cr).`,
    );
  }
  if (d.splitlessDeals) {
    notes.push(`${plural(d.splitlessDeals, 'counted deal')} ${d.splitlessDeals === 1 ? 'has' : 'have'} no revenue breakdown, so ${d.splitlessDeals === 1 ? 'its' : 'their'} full value is counted in the year it closed.`);
  }
  if (d.pendingApprovalDeals) {
    notes.push(`${plural(d.pendingApprovalDeals, 'won deal')} awaiting manager approval ${d.pendingApprovalDeals === 1 ? 'is' : 'are'} not counted yet.`);
  }
  return notes;
}
