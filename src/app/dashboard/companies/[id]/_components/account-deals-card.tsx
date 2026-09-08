import { Briefcase, PlusCircle } from 'lucide-react';

import type { AccountDealSummary } from '@/lib/companies/account-360';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

import { HoverPrefetchLink } from '../../../_components/hover-prefetch-link';

/**
 * Deals rollup for the Account 360 right rail.
 *
 * Ordered by most recently updated, capped in SQL, with the account's
 * true deal count in the header.
 *
 * "View All" passes the company's NAME, not its id. `companyIds=` is a
 * misleading name inherited from the deals filter bar: company is
 * free-text on a deal, so `listDealCompanyOptions` returns
 * `{ id: name, name }` and `companyFilterCondition` matches
 * `lower(deals.company_name)` OR the linked company's lowered name. A
 * UUID in this param is read as a company literally named
 * "90aa75f9-…", matches nothing, and renders as "Company: Unknown" —
 * a filter that is visibly applied and silently empty.
 *
 * The cost of that design is that two accounts sharing a name share a
 * filter result. That is the deals page's existing behaviour, not
 * something this card can fix from the outside.
 *
 * Amounts use each deal's OWN currency, not the tenant default: a deal
 * carries `currency` precisely because an account can hold deals in more
 * than one, and summing or re-labelling them here would invent a number.
 */
const STAGE_BADGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-600',
  qualified: 'bg-blue-100 text-blue-700',
  proposal: 'bg-indigo-100 text-indigo-700',
  negotiation: 'bg-amber-100 text-amber-800',
  hold: 'bg-orange-100 text-orange-700',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-rose-100 text-rose-700',
};

/**
 * Absolute, UTC-pinned. This card is server-rendered then hydrated, so a
 * locale- or timezone-relative label would produce two different strings
 * across the two passes.
 */
const closeDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatCloseDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(+d) ? null : closeDateFormatter.format(d);
}

export function AccountDealsCard({
  companyName,
  rows,
  total,
}: {
  /** The deals filter matches on name — see the note above. */
  companyName: string;
  rows: AccountDealSummary[];
  total: number;
}) {
  const viewAllHref = `/dashboard/deals?companyIds=${encodeURIComponent(
    companyName,
  )}`;
  const hidden = Math.max(0, total - rows.length);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-slate-900">
          <Briefcase className="h-3.5 w-3.5 text-slate-400" aria-hidden />
          Deals
          <span className="tabular-nums text-slate-400">({total})</span>
        </h2>
        {total > 0 ? (
          <HoverPrefetchLink
            href={viewAllHref}
            className="rounded px-1 py-0.5 text-[11px] font-medium text-indigo-600 transition hover:bg-indigo-50 hover:text-indigo-700"
          >
            View all
          </HoverPrefetchLink>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center">
          <PlusCircle className="h-6 w-6 text-slate-400" aria-hidden />
          <p className="mt-2 text-[12px] font-medium text-slate-700">
            No deals yet
          </p>
          <p className="mt-0.5 max-w-[15rem] text-[11.5px] text-slate-500">
            Nothing is in play with this account. Create a deal to put it
            on the pipeline.
          </p>
          <HoverPrefetchLink
            href="/dashboard/deals"
            className="mt-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            Create a deal
          </HoverPrefetchLink>
        </div>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-slate-100">
            {rows.map((d) => {
              const closeDate = formatCloseDate(d.expectedCloseDate);
              return (
                <li key={d.id} className="py-1.5 first:pt-0 last:pb-0">
                  <HoverPrefetchLink
                    href={`/dashboard/deals/${d.id}`}
                    className="group block rounded-md px-1 py-0.5 transition hover:bg-slate-50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-[12.5px] font-medium text-slate-900 group-hover:text-indigo-700">
                        {d.name}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide',
                          STAGE_BADGE_STYLES[d.stage],
                        )}
                      >
                        {DEAL_STAGE_LABELS[d.stage]}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between gap-2">
                      <span className="font-mono text-[12px] tabular-nums text-slate-700">
                        {formatCurrency(d.amountMinor, d.currency)}
                      </span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-slate-400">
                        {closeDate ?? 'No close date'}
                      </span>
                    </div>
                  </HoverPrefetchLink>
                </li>
              );
            })}
          </ul>
          {hidden > 0 ? (
            <HoverPrefetchLink
              href={viewAllHref}
              className="mt-2 block rounded-md border border-slate-200 px-2 py-1 text-center text-[11px] font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            >
              +{hidden} more {hidden === 1 ? 'deal' : 'deals'}
            </HoverPrefetchLink>
          ) : null}
        </>
      )}
    </section>
  );
}
