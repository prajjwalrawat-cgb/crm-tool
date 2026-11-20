import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { formatInr } from '@/lib/quotes/editor-form';
import { listQuotes } from '@/lib/quotes/queries';
import type { QuoteStatus } from '@/lib/quotes/types';
import { listTeammates } from '@/lib/teammates/queries';

import { inputCls } from '../settings/lead-capture/_components/ui';
import { QUOTE_STATUS_LABEL, QuoteStatusBadge, formatQuoteListDate } from './_components/quote-ui';

export const metadata = { title: 'Quotes' };

const PAGE_SIZE = 50;
const STATUSES = Object.keys(QUOTE_STATUS_LABEL) as QuoteStatus[];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const validDate = (v: string | undefined) => (v && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

export default async function QuotesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const statusParam = one(sp.status);
  const status = STATUSES.find((s) => s === statusParam);
  const rep = one(sp.rep);
  const from = validDate(one(sp.from));
  const to = validDate(one(sp.to));
  const cursor = one(sp.cursor);

  return await withTenantSession(async ({ tenant }) => {
    const [{ rows, nextCursor }, teammates] = await Promise.all([
      listQuotes(tenant.id, { status, createdBy: rep, from, to, cursor, limit: PAGE_SIZE }),
      listTeammates(tenant.id, tenant.name),
    ]);
    const repName = new Map(teammates.map((t) => [t.id, t.displayName]));

    const filters = new URLSearchParams();
    if (status) filters.set('status', status);
    if (rep) filters.set('rep', rep);
    if (from) filters.set('from', from);
    if (to) filters.set('to', to);
    const pageHref = (c?: string) => {
      const p = new URLSearchParams(filters);
      if (c) p.set('cursor', c);
      const qs = p.toString();
      return qs ? `/dashboard/quotes?${qs}` : '/dashboard/quotes';
    };
    const filtered = filters.size > 0;
    const selectCls = `${inputCls} w-auto py-1.5`;

    return (
      <main className="mx-auto w-full max-w-[88rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Quotes</h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Every quote and revision in {tenant.name}. Create a quote from its deal.
          </p>
        </header>

        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]">Status</span>
            <select name="status" defaultValue={status ?? ''} className={selectCls}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {QUOTE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]">Rep</span>
            <select name="rep" defaultValue={rep ?? ''} className={selectCls}>
              <option value="">All reps</option>
              {teammates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]">Quote date from</span>
            <input type="date" name="from" defaultValue={from ?? ''} className={selectCls} />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-600 dark:text-[#A1A1AA]">to</span>
            <input type="date" name="to" defaultValue={to ?? ''} className={selectCls} />
          </label>
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-3 py-2 text-[12.5px] font-medium text-white transition hover:bg-indigo-500"
          >
            Apply
          </button>
          {filtered ? (
            <Link href="/dashboard/quotes" className="px-2 py-2 text-[12.5px] text-slate-600 hover:underline dark:text-[#A1A1AA]">
              Clear
            </Link>
          ) : null}
        </form>

        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#0F0F0F]">
          <table className="w-full text-left text-[12.5px]">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:border-[#262626] dark:bg-[#111111] dark:text-[#A1A1AA]">
              <tr>
                <th className="px-3 py-2 font-medium">Quote</th>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Rep</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-slate-500 dark:text-[#A1A1AA]">
                    {filtered || cursor ? 'No quotes match these filters.' : 'No quotes yet. Open a deal and choose New quote.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-[#141414]">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/quotes/${r.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                        {r.quoteNumber}
                      </Link>
                      <span className="ml-1.5 text-slate-500 dark:text-[#A1A1AA]">Rev {r.revision}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/deals/${r.dealId}`} className="text-slate-800 hover:underline dark:text-[#E4E4E7]">
                        {r.dealName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-[#A1A1AA]">{r.companyName ?? '—'}</td>
                    <td className="px-3 py-2">
                      <QuoteStatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-[#FAFAFA]">{formatInr(r.totalMinor)}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-[#A1A1AA]">
                      {r.createdBy ? (repName.get(r.createdBy) ?? 'Teammate') : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-[#A1A1AA]">{formatQuoteListDate(r.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {cursor || nextCursor ? (
          <nav aria-label="Pagination" className="flex items-center justify-end gap-3 text-[12.5px]">
            {cursor ? (
              <Link href={pageHref()} className="text-indigo-600 hover:underline dark:text-indigo-400">
                First page
              </Link>
            ) : null}
            {nextCursor ? (
              <Link href={pageHref(nextCursor)} className="text-indigo-600 hover:underline dark:text-indigo-400">
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </main>
    );
  });
}
