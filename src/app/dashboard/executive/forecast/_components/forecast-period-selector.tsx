'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';

import {
  resolvePeriod,
  shiftPeriod,
  type PeriodMode,
} from '@/lib/deals/forecast/period';
import { cn } from '@/lib/utils';

/**
 * URL-driven period selector for the Forecast page: month/quarter toggle +
 * prev/next navigation. All period math is the pure helper; this only writes
 * `?mode=&period=` and lets the server re-render.
 */
export function ForecastPeriodSelector({
  mode,
  periodKey,
  label,
  fiscalStartMonth,
}: {
  mode: PeriodMode;
  periodKey: string;
  label: string;
  fiscalStartMonth: number;
}) {
  const router = useRouter();

  function go(nextMode: PeriodMode, nextKey: string) {
    router.replace(
      `/dashboard/executive/forecast?mode=${nextMode}&period=${nextKey}`,
      { scroll: false },
    );
  }

  function shift(delta: number) {
    const cur = resolvePeriod(mode, periodKey, new Date(), fiscalStartMonth);
    const next = shiftPeriod(cur, delta, fiscalStartMonth);
    go(mode, next.key);
  }

  function switchMode(nextMode: PeriodMode) {
    if (nextMode === mode) return;
    // Re-anchor: keep the current period's start month, resolve in the new mode.
    const cur = resolvePeriod(mode, periodKey, new Date(), fiscalStartMonth);
    const anchorKey = cur.startISO.slice(0, 7); // YYYY-MM
    const next = resolvePeriod(nextMode, anchorKey, new Date(), fiscalStartMonth);
    go(nextMode, next.key);
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1 rounded-md border border-slate-200 p-0.5 dark:border-[#262626]">
        {(['quarter', 'month'] as PeriodMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={cn(
              'rounded px-2.5 py-1 text-[12px] font-medium capitalize transition',
              m === mode
                ? 'bg-indigo-600 text-white'
                : 'text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
            )}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => shift(-1)}
          aria-label="Previous period"
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-[#181818]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="min-w-[7rem] text-center text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
          {label}
        </span>
        <button
          type="button"
          onClick={() => shift(1)}
          aria-label="Next period"
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-[#181818]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
