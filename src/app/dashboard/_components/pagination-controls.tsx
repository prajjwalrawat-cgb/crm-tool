'use client';

import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { PAGE_SIZES, type PageSize } from '@/lib/pagination/cursor';
import { cn } from '@/lib/utils';

/**
 * URL-driven pagination controls. Cursor pagination is forward-only at
 * the query layer; "Previous" reuses the browser's history stack so the
 * back button takes you to the prior cursor without us having to keep
 * a stack ourselves. The page-size selector resets the cursor (it
 * would be ambiguous to keep a cursor while changing the window size).
 */
export function PaginationControls({
  basePath,
  nextCursor,
  size,
  visibleCount,
}: {
  basePath: string;
  nextCursor: string | null;
  size: PageSize;
  visibleCount: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function navigate(updates: Record<string, string | null>) {
    const next = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => {
      router.push(`${basePath}${qs ? `?${qs}` : ''}`, { scroll: false });
    });
  }

  function handleNext() {
    if (!nextCursor) return;
    navigate({ cursor: nextCursor });
  }

  function handlePrev() {
    // Browser back is the source of truth for "previous page" because
    // the cursor that got us here was pushed onto history when Next was
    // clicked. If history is empty (deep link to a cursor URL) we fall
    // back to dropping the cursor entirely.
    if (window.history.length > 1) {
      router.back();
    } else {
      navigate({ cursor: null });
    }
  }

  function handleSizeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = Number(e.target.value);
    navigate({
      size: String(value),
      // Page-size change resets the cursor — different windows, different
      // boundaries.
      cursor: null,
    });
  }

  const hasCursor = Boolean(params?.get('cursor'));
  const canPrev = hasCursor;
  const canNext = nextCursor !== null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-4 py-2.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      <div className="flex items-center gap-2">
        <span>Showing {visibleCount} per page</span>
        <select
          aria-label="Page size"
          value={size}
          onChange={handleSizeChange}
          disabled={pending}
          className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
        >
          {PAGE_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handlePrev}
          disabled={pending || !canPrev}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50',
            'dark:border-zinc-800 dark:hover:bg-zinc-900',
          )}
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <ChevronLeft className="h-3 w-3" aria-hidden />
          )}
          Prev
        </button>
        <button
          type="button"
          onClick={handleNext}
          disabled={pending || !canNext}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50',
            'dark:border-zinc-800 dark:hover:bg-zinc-900',
          )}
        >
          Next
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
