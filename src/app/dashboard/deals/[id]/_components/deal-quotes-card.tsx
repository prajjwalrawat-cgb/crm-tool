import { FileSpreadsheet } from 'lucide-react';
import Link from 'next/link';

import { formatInr } from '@/lib/quotes/editor-form';
import type { QuoteStatus } from '@/lib/quotes/types';

import { QuoteStatusBadge, formatQuoteListDate } from '../../../quotes/_components/quote-ui';

export type DealQuoteRow = {
  id: string;
  quoteNumber: string;
  revision: number;
  status: QuoteStatus;
  totalMinor: number;
  /** ISO timestamp. */
  createdAt: string;
};

/**
 * The deal's quotes and revisions (read-only). Quotes are created from the
 * Quotes module, where they can be linked to this deal.
 */
export function DealQuotesCard({ quotes }: { quotes: DealQuoteRow[] }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FileSpreadsheet className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Quotes</h2>
          {quotes.length ? <span className="text-[10px] tabular-nums text-slate-400">{quotes.length}</span> : null}
        </div>
      </header>

      {quotes.length === 0 ? (
        <p className="text-[12px] text-slate-500">
          No quotes yet. Create one in{' '}
          <Link href="/dashboard/quotes" className="text-indigo-600 hover:underline">
            Quotes
          </Link>{' '}
          and link it to this deal.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-100">
          {quotes.map((q) => (
            <li key={q.id}>
              <Link
                href={`/dashboard/quotes/${q.id}`}
                className="flex items-center gap-2 py-2 text-[12.5px] hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                  {q.quoteNumber} <span className="font-normal text-slate-500">Rev {q.revision}</span>
                </span>
                <QuoteStatusBadge status={q.status} />
                <span className="w-24 text-right tabular-nums text-slate-800">{formatInr(q.totalMinor)}</span>
                <span className="w-24 text-right text-[11.5px] text-slate-400">{formatQuoteListDate(q.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
