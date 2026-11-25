'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { SearchHit, SearchResponse } from '@/lib/search/types';
import { cn } from '@/lib/utils';

import { inputCls } from '../../settings/lead-capture/_components/ui';

export type EntityKind = 'deal' | 'company' | 'contact';
export type EntityChoice = { id: string; label: string; sublabel?: string | null };

const DEBOUNCE_MS = 250;
const PLACEHOLDER: Record<EntityKind, string> = {
  deal: 'Search deals…',
  company: 'Search companies…',
  contact: 'Search contacts…',
};

/**
 * Compact search-as-you-type picker over /api/search (the command palette's
 * endpoint, same RBAC: reps see their own and unassigned records). Results
 * render inline under the input so nothing spills out of a bottom sheet.
 */
export function EntitySearchSelect({
  kind,
  label,
  value,
  onChange,
  disabled,
}: {
  kind: EntityKind;
  label: string;
  value: EntityChoice | null;
  onChange: (v: EntityChoice | null) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [term, setTerm] = useState('');
  const [result, setResult] = useState<{ term: string; hits: EntityChoice[]; error: string | null } | null>(null);
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
  useEffect(() => {
    if (!q) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as SearchResponse;
        if (mine !== seq.current) return;
        const hits = body.hits
          .filter((h: SearchHit) => h.kind === kind)
          .map((h) => ({ id: h.id, label: h.title, sublabel: h.subtitle }));
        setResult({ term: q, hits, error: null });
        setActive(0);
      } catch {
        if (mine !== seq.current) return;
        setResult({ term: q, hits: [], error: 'Search failed. Check your connection.' });
        setActive(0);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, kind]);

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

  const loading = q !== '' && result?.term !== q;
  const hits = q && result?.term === q ? result.hits : [];
  const error = q && result?.term === q ? result.error : null;
  const activeIndex = Math.min(active, hits.length - 1);
  const optionId = (i: number) => `${listId}-opt-${i}`;

  function pick(h: EntityChoice) {
    focusNext.current = 'chip';
    onChange(h);
    setTerm('');
  }

  /** Combobox keys: ArrowUp/Down move the active option, Enter picks it, Escape closes the list. */
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && hits.length > 0) {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp' && hits.length > 0) {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === 'Enter') {
      // Never submit the surrounding form from the search box.
      e.preventDefault();
      const h = hits[activeIndex];
      if (h) pick(h);
    } else if (e.key === 'Escape' && term) {
      // Close the list without also closing the sheet.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
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
          aria-expanded={q !== ''}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={hits[activeIndex] ? optionId(activeIndex) : undefined}
          disabled={disabled}
          value={term}
          placeholder={PLACEHOLDER[kind]}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(inputCls, 'min-h-10 pl-9 text-[14px] sm:text-[13px]')}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-hidden />
        ) : null}
      </div>
      {q ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-[#2A2A2A]">
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-48 overflow-y-auto">
            {hits.map((h, i) => (
              <li
                key={h.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseEnter={() => setActive(i)}
                // Keep focus in the input so the keyboard and the active option stay in sync.
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
              <span className="block px-3 py-3 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">No matches for “{q}”.</span>
            ) : null}
            {loading && hits.length === 0 ? (
              <span className="block px-3 py-3 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">Searching…</span>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
