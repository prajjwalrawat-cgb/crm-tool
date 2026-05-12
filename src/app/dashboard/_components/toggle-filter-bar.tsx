'use client';

import { Filter, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { cn } from '@/lib/utils';

/**
 * Lightweight, URL-driven filter bar for entity pages that don't need
 * the full popover machinery (companies, contacts). Renders a row of
 * toggle chips — each writes a fixed key=value pair into the URL.
 * Mirrors the visual language of the deals filter bar so the product
 * feels consistent across pages.
 */

export type FilterToggle = {
  /** URL param key (e.g. "hasDeals"). */
  key: string;
  /** URL param value when active (defaults to "1"). */
  value?: string;
  /** Display label on the chip. */
  label: string;
  /** Tooltip hint. */
  title?: string;
};

export function ToggleFilterBar({
  basePath,
  toggles,
  /** Additional URL keys (besides the toggle keys) that should be wiped
   *  when "Clear all" is pressed. Useful when a sibling filter UI
   *  (search bar, sort) writes its own keys. */
  alsoClear = [],
}: {
  basePath: string;
  toggles: FilterToggle[];
  alsoClear?: string[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const isActive = useCallback(
    (t: FilterToggle): boolean => {
      const want = t.value ?? '1';
      return params.get(t.key) === want;
    },
    [params],
  );

  const toggle = useCallback(
    (t: FilterToggle) => {
      const merged = new URLSearchParams(params.toString());
      merged.delete('cursor');
      const want = t.value ?? '1';
      if (params.get(t.key) === want) {
        merged.delete(t.key);
      } else {
        merged.set(t.key, want);
      }
      const qs = merged.toString();
      router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [router, basePath, params],
  );

  const clearAll = useCallback(() => {
    const merged = new URLSearchParams(params.toString());
    for (const t of toggles) merged.delete(t.key);
    for (const k of alsoClear) merged.delete(k);
    merged.delete('cursor');
    const qs = merged.toString();
    router.replace(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
  }, [router, basePath, params, toggles, alsoClear]);

  const anyActive = toggles.some((t) => isActive(t));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Filter className="h-3 w-3" aria-hidden />
        Filter
      </span>
      {toggles.map((t) => {
        const active = isActive(t);
        return (
          <button
            key={t.key + (t.value ?? '')}
            type="button"
            onClick={() => toggle(t)}
            title={t.title}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
              active
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            {t.label}
          </button>
        );
      })}
      {anyActive ? (
        <button
          type="button"
          onClick={clearAll}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <X className="h-3 w-3" aria-hidden />
          Clear all
        </button>
      ) : null}
    </div>
  );
}
