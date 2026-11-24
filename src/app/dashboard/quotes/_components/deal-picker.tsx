'use client';

import { Check, Loader2, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { searchDealsForQuoteAction } from '@/lib/quotes/actions';
import type { QuoteDealOption } from '@/lib/quotes/queries';
import { cn } from '@/lib/utils';

import { inputCls } from '../../settings/lead-capture/_components/ui';

const SEARCH_DEBOUNCE_MS = 250;

const stageLabel = (stage: string) => DEAL_STAGE_LABELS[stage as keyof typeof DEAL_STAGE_LABELS] ?? stage;

/**
 * Search box with an inline, scrollable result list (no floating popover, so
 * it never spills out of a dialog). Arrow keys move, Enter picks.
 */
export function DealPicker({
  selectedId,
  onSelect,
  limitedToOwnDeals,
  disabled,
  autoFocus,
}: {
  selectedId: string | null;
  onSelect: (deal: QuoteDealOption) => void;
  /** Reps: the list only holds deals they own or unassigned ones. */
  limitedToOwnDeals: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const listId = useId();
  const [term, setTerm] = useState('');
  // The last search answered, tagged with the term it was for.
  const [result, setResult] = useState<{ term: string; deals: QuoteDealOption[]; error: string | null } | null>(null);
  const [active, setActive] = useState(0);
  const requestSeq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Debounced search; stale responses are dropped.
  useEffect(() => {
    const seq = ++requestSeq.current;
    const t = setTimeout(async () => {
      const res = await searchDealsForQuoteAction(term);
      if (seq !== requestSeq.current) return;
      setResult(res.ok ? { term, deals: res.deals, error: null } : { term, deals: [], error: res.error });
      setActive(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term]);

  const loading = result?.term !== term;
  const deals = result?.deals ?? [];
  const error = result?.error ?? null;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, deals.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const d = deals[active];
      if (d) onSelect(d);
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={deals[active] ? `${listId}-${active}` : undefined}
          aria-label="Search deals"
          autoFocus={autoFocus}
          disabled={disabled}
          value={term}
          placeholder="Search by deal or company name…"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(inputCls, 'pl-9')}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-hidden />
        ) : null}
      </div>

      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Deals"
        aria-busy={loading}
        className="h-64 overflow-y-auto rounded-lg border border-slate-200 dark:border-[#2A2A2A]"
      >
        {deals.map((d, i) => {
          const selected = d.id === selectedId;
          return (
            <li
              key={d.id}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setActive(i)}
              onClick={() => !disabled && onSelect(d)}
              className={cn(
                'flex cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0 dark:border-[#1F1F1F]',
                i === active && 'bg-slate-50 dark:bg-[#161616]',
                selected && 'bg-indigo-50 dark:bg-indigo-500/10',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{d.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                  {d.companyName ? <span className="truncate">{d.companyName}</span> : null}
                  <span className="rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-[#1F1F1F] dark:text-[#D4D4D8]">
                    {stageLabel(d.stage)}
                  </span>
                  {d.amountMinor > 0 ? <span className="tabular-nums">{formatCurrency(d.amountMinor, d.currency)}</span> : null}
                  <span>{d.ownerName ?? 'Unassigned'}</span>
                </span>
              </span>
              {selected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" aria-label="Selected" /> : null}
            </li>
          );
        })}
        {!loading && error ? <li className="px-3 py-6 text-center text-[12.5px] text-rose-600">{error}</li> : null}
        {!loading && !error && deals.length === 0 ? (
          <li className="px-3 py-6 text-center text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
            {term.trim() ? `No deals match “${term.trim()}”.` : 'No deals to link yet.'}
          </li>
        ) : null}
        {loading && deals.length === 0 ? (
          <li className="px-3 py-6 text-center text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">Searching…</li>
        ) : null}
      </ul>

      <p className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
        {limitedToOwnDeals ? 'Showing your deals and unassigned deals. ' : ''}Most recently updated first; type to search.
      </p>
    </div>
  );
}
