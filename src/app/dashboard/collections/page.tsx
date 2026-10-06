import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import {
  buildDiagnostic,
  drillDown,
  SPOC_FLAG_LABELS,
  type DrillDeal,
  type SpocFlag,
} from '@/lib/collections/diagnostic';
import { loadDiagnosticInput, type ReportPeriod } from '@/lib/collections/queries';
import { formatTenantCurrency, type TenantCurrencyContext } from '@/lib/currency/format';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { can } from '@/lib/rbac';
import { currentFiscalYear, fiscalYearChoices, fiscalYearLabel } from '@/lib/targets/fiscal';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { Tile } from '../incentives/_components/incentive-calculator';
import { CollectionsFilters } from './_components/collections-filters';

export const metadata = { title: 'Collections' };

const PERIODS: readonly ReportPeriod[] = ['fy', 'q1', 'q2', 'q3', 'q4'];

/**
 * Credit Period vs Achievement (collections addendum, Phase A). Every figure
 * comes from `buildDiagnostic` / `drillDown`; this page only formats them.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; period?: string; spoc?: string }>;
}) {
  await requirePersonas(['admin', 'manager']);
  return await withTenantSession(async ({ tenant }) => {
    const membership = await requireMembership();
    if (!can(membership.role, 'viewCollections')) throw new Error('You do not have access to the collections report.');
    const sp = await searchParams;
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    const choices = fiscalYearChoices(startMonth, now);
    const parsedFy = Number(sp.fy);
    const fiscalYear = Number.isInteger(parsedFy) && choices.includes(parsedFy) ? parsedFy : currentFiscalYear(startMonth, now);
    const period: ReportPeriod = PERIODS.includes(sp.period as ReportPeriod) ? (sp.period as ReportPeriod) : 'fy';
    const asOf = now.toISOString().slice(0, 10);

    const [input, teammates] = await Promise.all([
      loadDiagnosticInput({ tenantId: tenant.id, fiscalYear, startMonth, period, asOf }),
      listTeammates(tenant.id, tenant.name),
    ]);
    const diag = buildDiagnostic(input);
    const nameOf = new Map(teammates.map((t) => [t.id, t.displayName]));
    const spoc = sp.spoc && diag.rows.some((r) => r.ownerId === sp.spoc) ? sp.spoc : '';
    const rows = spoc ? diag.rows.filter((r) => r.ownerId === spoc) : diag.rows;
    const drill = spoc ? drillDown(input, spoc) : null;

    const ctx: TenantCurrencyContext = {
      defaultCurrency: settings.defaultCurrency,
      currencyLocale: settings.currencyLocale,
      compactNumbers: settings.compactNumbers,
    };
    const money = (m: number) => formatTenantCurrency(m, ctx);
    const s = input.settings;
    const label = `${fiscalYearLabel(startMonth, fiscalYear)}${period === 'fy' ? '' : ` · ${period.toUpperCase()}`}`;
    const sum = diag.summary;
    const hrefFor = (owner: string) => `/dashboard/collections?fy=${fiscalYear}&period=${period}&spoc=${encodeURIComponent(owner)}`;

    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Credit period vs achievement · {label}</h1>
            <p className="mt-0.5 max-w-3xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Who is hitting their number by giving customers long credit? Booking is the sales number; collection is the
              commercial one. Standard credit period: <strong>{s.standardCreditDays} days</strong> (materially above ={' '}
              more than {s.standardCreditDays + s.materialExcessDays}).
              {can(membership.role, 'manageCollectionSettings') ? (
                <>
                  {' '}
                  <Link href="/dashboard/settings/credit-terms" className="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300">
                    Change
                  </Link>
                </>
              ) : null}
            </p>
          </div>
          <CollectionsFilters
            fiscalYear={fiscalYear}
            fyChoices={choices.map((y) => ({ value: y, label: fiscalYearLabel(startMonth, y) }))}
            period={period}
            spoc={spoc}
            spocChoices={diag.rows.map((r) => ({ value: r.ownerId, label: nameOf.get(r.ownerId) ?? r.ownerId }))}
          />
        </div>

        {/* The founder's number first: what's booked vs what's actually come in. */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          <div className="col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-500/30 dark:bg-rose-500/10">
            <div className="text-[12px] font-medium text-rose-800 dark:text-rose-200">Booked but not yet collected</div>
            <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-rose-900 dark:text-rose-100">{money(sum.bookingVsCollectionGapMinor)}</div>
            <div className="text-[12px] text-rose-700 dark:text-rose-300">
              {money(sum.bookedMinor)} booked − {money(sum.collectedMinor)} collected in this period
            </div>
          </div>
          <Tile label="Booked (won deals)" value={money(sum.bookedMinor)} />
          <Tile label="Invoiced" value={money(sum.invoicedMinor)} sub={`${money(sum.invoicedNotCollectedMinor)} invoiced not collected`} />
          <Tile label="Collected" value={money(sum.collectedMinor)} sub="payments received in the period" tone="good" />
        </div>

        <ul className="mt-3 space-y-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          {sum.assumedTermsDeals > 0 ? (
            <li>• {sum.assumedTermsDeals} booked deal(s) have no credit terms recorded — counted at the {s.standardCreditDays}-day standard (assumed), not as compliant.</li>
          ) : null}
          {sum.unapprovedOverrideDeals > 0 ? (
            <li className="text-amber-700 dark:text-amber-300">• {sum.unapprovedOverrideDeals} booked deal(s) have longer-than-standard terms nobody approved.</li>
          ) : null}
          {sum.unattributedInvoices > 0 ? (
            <li>• {sum.unattributedInvoices} invoice(s) ({money(sum.unattributedInvoicedMinor)}) aren’t linked to a deal, so they count in totals but not against any SPOC. Link them from the Invoices page.</li>
          ) : null}
          <li>• Collections only include payments recorded against invoices in Saleinx.</li>
        </ul>

        <div className="mt-5 overflow-x-auto rounded-lg border border-slate-200 dark:border-[#1F1F1F]">
          <table className="w-full text-[13px] tabular-nums">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
              <tr>
                <th className="px-3 py-2 font-medium">SPOC</th>
                <th className="px-3 py-2 text-right font-medium">Booked</th>
                <th className="px-3 py-2 text-right font-medium">Agreed credit</th>
                <th className="px-3 py-2 text-right font-medium">Days to collect</th>
                <th className="px-3 py-2 text-right font-medium">Not fully collected</th>
                <th className="px-3 py-2 text-right font-medium">Achievement</th>
                <th className="px-3 py-2 text-right font-medium">Standard</th>
                <th className="px-3 py-2 font-medium">Flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                    No won deals, invoices or targets in {label}.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.ownerId} className={cn('border-t border-slate-100 dark:border-[#1F1F1F]', r.flag === 'funding_customers' && 'bg-rose-50/50 dark:bg-rose-500/5')}>
                    <td className="px-3 py-2">
                      <Link href={hrefFor(r.ownerId)} className="font-medium text-slate-800 hover:text-indigo-600 dark:text-[#FAFAFA]">
                        {nameOf.get(r.ownerId) ?? r.ownerId}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {money(r.bookedMinor)}
                      <div className="text-[11px] text-slate-400">{r.bookedDeals} deal(s)</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.avgAgreedCreditDays != null ? `${r.avgAgreedCreditDays} d` : '—'}
                      {r.assumedTermsDeals > 0 || r.unapprovedOverrideDeals > 0 ? (
                        <div className="text-[11px] text-slate-400">
                          {r.assumedTermsDeals > 0 ? `${r.assumedTermsDeals} assumed` : ''}
                          {r.assumedTermsDeals > 0 && r.unapprovedOverrideDeals > 0 ? ' · ' : ''}
                          {r.unapprovedOverrideDeals > 0 ? <span className="text-amber-600">{r.unapprovedOverrideDeals} unapproved</span> : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.avgDaysToCollect != null ? `${r.avgDaysToCollect} d` : '—'}
                      <div className="text-[11px] text-slate-400">{r.collectedInvoices} paid in full</div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {money(r.partialOutstandingMinor + r.unpaidOutstandingMinor)}
                      <div className="text-[11px] text-slate-400">
                        {r.partialInvoices} part-paid · {r.unpaidInvoices} unpaid
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">{r.achievementPct != null ? `${Math.round(r.achievementPct * 100)}%` : <span className="text-[11px] text-slate-400">no target</span>}</td>
                    <td className="px-3 py-2 text-right">{r.standardCreditDays} d</td>
                    <td className="px-3 py-2">
                      <FlagChip flag={r.flag} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-400 dark:text-[#71717A]">
          Sorted by agreed credit period. Averages are value-weighted. Days to collect counts only invoices paid in full; part-paid and
          unpaid invoices are shown separately. Flags compare achievement with the team median
          {diag.medianAchievementPct != null ? ` (${Math.round(diag.medianAchievementPct * 100)}%)` : ''}.
        </p>

        {drill ? (
          <section className="mt-6">
            <h2 className="mb-2 text-[14px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {nameOf.get(spoc) ?? spoc} — deals above the {s.standardCreditDays}-day standard
            </h2>
            {drill.length === 0 ? (
              <p className="text-[13px] text-slate-500">None in {label}.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-[#1F1F1F]">
                <table className="w-full text-[13px] tabular-nums">
                  <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
                    <tr>
                      <th className="px-3 py-2 font-medium">Deal</th>
                      <th className="px-3 py-2 text-right font-medium">Value</th>
                      <th className="px-3 py-2 text-right font-medium">Credit</th>
                      <th className="px-3 py-2 font-medium">Approved by</th>
                      <th className="px-3 py-2 font-medium">Collection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.map((d) => (
                      <tr key={d.dealId} className="border-t border-slate-100 dark:border-[#1F1F1F]">
                        <td className="px-3 py-2">
                          <Link href={`/dashboard/deals/${d.dealId}`} className="font-medium text-slate-800 hover:text-indigo-600 dark:text-[#FAFAFA]">
                            {d.name}
                          </Link>
                          <div className="text-[11px] text-slate-400">won {d.closedOn}</div>
                        </td>
                        <td className="px-3 py-2 text-right">{money(d.amountMinor)}</td>
                        <td className="px-3 py-2 text-right">{d.creditDays} d</td>
                        <td className="px-3 py-2">
                          {d.unapproved ? <span className="text-amber-700 dark:text-amber-300">Not approved</span> : (nameOf.get(d.approvedBy ?? '') ?? d.approvedBy)}
                        </td>
                        <td className="px-3 py-2">
                          <CollectionChip value={d.collection} />
                          {d.invoices.length > 0 ? <div className="text-[11px] text-slate-400">{d.invoices.map((i) => i.piNumber).join(', ')}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </main>
    );
  });
}

function FlagChip({ flag }: { flag: SpocFlag }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        flag === 'funding_customers' && 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200',
        flag === 'outperforming' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
        flag === 'underperforming' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
        flag === 'standard' && 'bg-slate-100 text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]',
      )}
    >
      {SPOC_FLAG_LABELS[flag]}
    </span>
  );
}

const COLLECTION_LABEL: Record<DrillDeal['collection'], string> = {
  on_time: 'Collected on time',
  late: 'Collected late',
  outstanding: 'Outstanding',
  overdue: 'Overdue',
  not_invoiced: 'Not invoiced',
};

function CollectionChip({ value }: { value: DrillDeal['collection'] }) {
  return (
    <span
      className={cn(
        'text-[12px] font-medium',
        value === 'on_time' && 'text-emerald-700 dark:text-emerald-400',
        (value === 'late' || value === 'outstanding') && 'text-amber-700 dark:text-amber-300',
        value === 'overdue' && 'text-rose-700 dark:text-rose-400',
        value === 'not_invoiced' && 'text-slate-500',
      )}
    >
      {COLLECTION_LABEL[value]}
    </span>
  );
}
