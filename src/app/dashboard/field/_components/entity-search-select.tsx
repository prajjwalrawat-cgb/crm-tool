'use client';

import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { PickerChoice, PickerKind, PickerResponse } from '@/lib/field/picker-link';
import { cn } from '@/lib/utils';

import { inputCls } from '../../settings/lead-capture/_components/ui';

export type EntityKind = PickerKind;
export type EntityChoice = PickerChoice;

const DEBOUNCE_MS = 250;
const PLACEHOLDER: Record<EntityKind, string> = {
  deal: 'Choose or search deals…',
  company: 'Choose or search companies…',
  contact: 'Choose or search contacts…',
};
const NOUN: Record<EntityKind, string> = { deal: 'deals', company: 'companies', contact: 'contacts' };

/**
 * Searchable dropdown over /api/field/pickers. Focusing or clicking the box opens
 * the list straight away with up to 20 records the user can see (the CRM's own
 * visibility rule), most recently updated first; typing filters (debounced).
 * `companyId` narrows deals and contacts to one company. Results render inline
 * under the input so nothing spills out of a bottom sheet.
 */
export function EntitySearchSelect({
  kind,
  label,
  value,
  onChange,
  companyId,
  disabled,
}: {
  kind: EntityKind;
  label: string;
  value: EntityChoice | null;
  onChange: (v: EntityChoice | null) => void;
  /** Deals and contacts: only this company's. */
  companyId?: string | null;
  disabled?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ key: string; hits: EntityChoice[]; error: string | null } | null>(null);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  // Picking swaps the input for a chip (and clearing swaps back): move focus across so keyboard users keep their place.
  const focusNext = useRef<'chip' | 'input' | null>(null);
  const takeFocus = (target: 'chip' | 'input') => (el: HTMLElement | null) => {
    if (el && focusNext.current === target) {
      focusNext.current = null;
      el.focus();
    }
  };

  const q = term.trim();
  const scopedCompany = kind === 'company' ? null : (companyId ?? null);
  const key = `${q}|${scopedCompany ?? ''}`;
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const t = setTimeout(
      async () => {
        try {
          const params = new URLSearchParams({ kind });
          if (q) params.set('q', q);
          if (scopedCompany) params.set('companyId', scopedCompany);
          const res = await fetch(`/api/field/pickers?${params}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          const body = (await res.json()) as PickerResponse;
          if (mine !== seq.current) return;
          setResult({ key, hits: body.items, error: null });
          setActive(0);
        } catch {
          if (mine !== seq.current) return;
          setResult({ key, hits: [], error: 'Could not load the list. Check your connection.' });
          setActive(0);
        }
      },
      // The first, unfiltered list opens immediately; typing is debounced.
      q ? DEBOUNCE_MS : 0,
    );
    return () => clearTimeout(t);
  }, [open, q, kind, scopedCompany, key]);

  // Keep the keyboard-active option visible in the scrolling list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, result]);

  if (value) {
    return (
      <div className="space-y-1">
        <span className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">{label}</span>
        <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-1.5 text-[13px] dark:border-indigo-500/30 dark:bg-indigo-500/10">
          <span className="min-w-0">
            <span className="block truncate font-medium text-slate-900 dark:text-[#FAFAFA]">{value.label}</span>
            {value.sublabel ? (
              <span className="block truncate text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{value.sublabel}</span>
            ) : null}
          </span>
          <button
            type="button"
            disabled={disabled}
            ref={takeFocus('chip')}
            onClick={() => {
              focusNext.current = 'input';
              onChange(null);
            }}
            aria-label={`Clear ${label.toLowerCase()}`}
            className="rounded-md p-1.5 text-slate-500 hover:bg-white disabled:opacity-50 dark:hover:bg-[#181818]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  const ready = result?.key === key;
  const loading = open && !ready;
  const hits = open && ready ? result.hits : [];
  const error = open && ready ? result.error : null;
  const activeIndex = Math.min(active, hits.length - 1);
  const optionId = (i: number) => `${listId}-opt-${i}`;

  function pick(h: EntityChoice) {
    focusNext.current = 'chip';
    setOpen(false);
    setTerm('');
    onChange(h);
  }

  /** Combobox keys: ArrowDown opens / moves, ArrowUp moves, Enter picks, Escape closes the list. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else if (hits.length > 0) setActive(Math.min(activeIndex + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp' && hits.length > 0) {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      // Never submit the surrounding form from the search box.
      e.preventDefault();
      const h = hits[activeIndex];
      if (h) pick(h);
    } else if (e.key === 'Escape' && (open || term)) {
      // Close the list without also closing the sheet.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
      setTerm('');
    }
  }

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          id={inputId}
          ref={takeFocus('input')}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && hits[activeIndex] ? optionId(activeIndex) : undefined}
          autoComplete="off"
          disabled={disabled}
          value={term}
          placeholder={PLACEHOLDER[kind]}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={cn(inputCls, 'min-h-10 pl-9 pr-9 text-[14px] sm:text-[13px]')}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-hidden />
        ) : (
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        )}
      </div>
      {open ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-[#2A2A2A]">
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto">
            {hits.map((h, i) => (
              <li
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActive(i)}
                // Keep focus in the input so the keyboard and the active option stay in sync (and blur doesn't close the list).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(h)}
                className={cn(
                  'cursor-pointer border-b border-slate-100 px-3 py-2.5 last:border-b-0 dark:border-[#1F1F1F]',
                  i === activeIndex && 'bg-slate-100 dark:bg-[#1A1A1A]',
                )}
              >
                <span className="block truncate text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">{h.label}</span>
                {h.sublabel ? (
                  <span className="block truncate text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{h.sublabel}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {/* Status lines live outside the listbox (only options belong in it). */}
          <p role="status" className="empty:hidden">
            {!loading && error ? <span className="block px-3 py-3 text-[12.5px] text-rose-600">{error}</span> : null}
            {!loading && !error && hits.length === 0 ? (
              <span className="block px-3 py-3 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
                {q ? `No matches for “${q}”.` : scopedCompany ? `No ${NOUN[kind]} for this company.` : `No ${NOUN[kind]} yet.`}
              </span>
            ) : null}
            {loading && hits.length === 0 ? (
              <span className="block px-3 py-3 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">Loading…</span>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
