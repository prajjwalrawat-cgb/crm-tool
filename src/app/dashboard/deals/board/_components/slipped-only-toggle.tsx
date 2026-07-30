'use client';

import { Flag } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

import { cn } from '@/lib/utils';

/**
 * Board-header toggle that isolates the slipping cohort across every stage
 * column in one click — `push_count >= 1`, server-side (see `DealFilters.
 * slipped`), so the columns and their totals both narrow.
 *
 * URL-driven like the rest of the deal filters: state lives in `?slipped=1`,
 * so the view is shareable and survives a refresh. Uses `replace` (not `push`)
 * to keep the back stack quiet, matching DealFilterBar.
 */
export function SlippedOnlyToggle({
  active,
  totalSlipped,
}: {
  active: boolean;
  /** Slipped deals visible across the whole board — hides the toggle at 0. */
  totalSlipped: number;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const toggle = useCallback(() => {
    const next = new URLSearchParams(params?.toString() ?? '');
    if (active) next.delete('slipped');
    else next.set('slipped', '1');
    // Any filter change invalidates the per-column cursors.
    next.delete('cursor');
    const qs = next.toString();
    router.replace(`/dashboard/deals/board${qs ? `?${qs}` : ''}`, {
      scroll: false,
    });
  }, [active, params, router]);

  // Nothing has slipped and the filter isn't on — don't offer a toggle that
  // would empty the board.
  if (totalSlipped === 0 && !active) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      title="Deals whose expected close date has been pushed out at least once"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition',
        active
          ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
      )}
    >
      <Flag className="h-3 w-3" aria-hidden />
      Show slipped deals only
      {totalSlipped > 0 ? (
        <span className="tabular-nums opacity-70">({totalSlipped})</span>
      ) : null}
    </button>
  );
}
