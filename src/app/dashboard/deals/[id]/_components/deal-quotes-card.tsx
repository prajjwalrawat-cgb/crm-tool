'use client';

import { FileSpreadsheet, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { createQuoteAction } from '@/lib/quotes/actions';
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

export type QuoteTemplateChoice = { id: string; name: string; isDefault: boolean };

/** The deal's quotes and revisions, plus "New quote" (template picker when there is a choice). */
export function DealQuotesCard({
  dealId,
  quotes,
  templates,
  canCreate,
}: {
  dealId: string;
  quotes: DealQuoteRow[];
  templates: QuoteTemplateChoice[];
  canCreate: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [picking, setPicking] = useState(false);
  const defaultId = (templates.find((t) => t.isDefault) ?? templates[0])?.id ?? '';
  const [templateId, setTemplateId] = useState(defaultId);

  function create(chosen?: string) {
    startTransition(async () => {
      const res = await createQuoteAction({ dealId, ...(chosen ? { templateId: chosen } : {}) });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      router.push(`/dashboard/quotes/${res.id}`);
    });
  }

  // No picker with zero or one template (the server falls back to the default).
  const onNew = () => (templates.length > 1 ? setPicking(true) : create());

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FileSpreadsheet className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Quotes</h2>
          {quotes.length ? <span className="text-[10px] tabular-nums text-slate-400">{quotes.length}</span> : null}
        </div>
        {canCreate && !picking ? (
          <button
            type="button"
            onClick={onNew}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[12px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
            New quote
          </button>
        ) : null}
      </header>

      {picking ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-slate-50 p-2">
          <label htmlFor={`quote-template-${dealId}`} className="text-[12px] text-slate-600">
            Template
          </label>
          <select
            id={`quote-template-${dealId}`}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[12px] text-slate-800 focus:border-indigo-400 focus:outline-none"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.isDefault ? `${t.name} (default)` : t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => create(templateId)}
            disabled={pending || !templateId}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-indigo-500 disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Create
          </button>
          <button
            type="button"
            onClick={() => setPicking(false)}
            disabled={pending}
            className="px-1.5 py-1 text-[12px] text-slate-500 hover:text-slate-800"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {quotes.length === 0 ? (
        <p className="text-[12px] text-slate-500">No quotes yet.</p>
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
