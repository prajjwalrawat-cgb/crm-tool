import type { MeetingStatus } from '@/db/schema/enums';

const CHECKED_IN: MeetingStatus[] = ['checked_in', 'checked_out', 'mom_logged'];

export function computeKpis(
  rows: Array<{
    status: MeetingStatus;
    atRisk: boolean;
    dealId: string | null;
    amountMinor: number | null;
    currency: string | null;
  }>,
  tenantCurrency: string,
): { planned: number; checkedIn: number; atRisk: number; pipelineMinor: number; otherCurrencyDeals: number } {
  let planned = 0;
  let checkedIn = 0;
  let atRisk = 0;
  let pipelineMinor = 0;
  const seenDeals = new Set<string>();
  const otherDeals = new Set<string>();
  for (const r of rows) {
    if (r.status === 'cancelled') continue;
    planned++;
    if (CHECKED_IN.includes(r.status)) checkedIn++;
    if (r.atRisk) atRisk++;
    if (!r.dealId || seenDeals.has(r.dealId)) continue;
    seenDeals.add(r.dealId);
    if (r.amountMinor == null) continue;
    if (r.currency && r.currency !== tenantCurrency) otherDeals.add(r.dealId);
    else pipelineMinor += r.amountMinor;
  }
  return { planned, checkedIn, atRisk, pipelineMinor, otherCurrencyDeals: otherDeals.size };
}
