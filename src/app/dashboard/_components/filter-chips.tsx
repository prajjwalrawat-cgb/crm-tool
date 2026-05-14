'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Renders one removable pill per active filter. Each pill links back to
 * the same page with that filter cleared, so removal is a plain HTML
 * navigation — no client state, no transition flicker. The pill set is
 * derived from explicitly named keys so we never display internal noise
 * like `q`, `cursor`, or `size` as a "filter."
 */
export type FilterChip = {
  /** URL key(s) this chip controls. Removing the chip strips all listed keys. */
  keys: string[];
  /** Visual label rendered in the pill (e.g. "Owner: Priya"). */
  label: string;
  /** Stable identity used for React keys + dedupe. */
  id: string;
};

export function FilterChips({
  chips,
  className,
}: {
  chips: FilterChip[];
  className?: string;
}) {
  const pathname = usePathname();
  const sp = useSearchParams();

  if (chips.length === 0) return null;

  function hrefWithout(keys: string[]): string {
    const next = new URLSearchParams(sp?.toString() ?? '');
    for (const k of keys) next.delete(k);
    // Reset paging — different filter means cursor is stale.
    next.delete('cursor');
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  function clearAllHref(): string {
    const next = new URLSearchParams(sp?.toString() ?? '');
    for (const c of chips) for (const k of c.keys) next.delete(k);
    next.delete('cursor');
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  return (
    <div
      className={
        className ??
        'flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1.5 text-[12px]'
      }
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Filters
      </span>
      {chips.map((chip) => (
        <Link
          key={chip.id}
          href={hrefWithout(chip.keys)}
          className="group inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-50"
          title={`Clear ${chip.label}`}
        >
          <span>{chip.label}</span>
          <X
            className="h-3 w-3 text-indigo-400 transition group-hover:text-indigo-600"
            aria-hidden
          />
        </Link>
      ))}
      {chips.length > 1 ? (
        <Link
          href={clearAllHref()}
          className="ml-1 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
        >
          Clear all
        </Link>
      ) : null}
    </div>
  );
}
