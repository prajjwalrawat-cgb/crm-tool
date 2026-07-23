'use client';

import { CalendarRange } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  DASHBOARD_RANGE_PRESETS,
  DASHBOARD_RANGE_SHORT_LABELS,
  isoDay,
  type DashboardRange,
} from '@/lib/dashboard/range';
import { cn } from '@/lib/utils';

/**
 * The dashboard's date-range picker. Writes a single `range` param
 * (plus `from`/`to` when custom) and preserves everything else already
 * in the URL — critically `view=rep:<id>`, so changing the window
 * doesn't silently reset the owner filter.
 *
 * Server is the source of truth: this only navigates. Every widget on
 * the page re-reads the same param, which is what keeps the KPI strip,
 * trend chart, stage bars and highlights in lockstep.
 */
export function DashboardRangeFilter({ range }: { range: DashboardRange }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [customOpen, setCustomOpen] = useState(range.preset === 'custom');
  const [from, setFrom] = useState(isoDay(range.from));
  // `range.to` is exclusive internally; the input shows the inclusive day.
  const [to, setTo] = useState(isoDay(new Date(range.to.getTime() - 86_400_000)));

  function push(next: URLSearchParams) {
    start(() => {
      router.replace(`/dashboard?${next.toString()}`);
    });
  }

  function selectPreset(preset: string) {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set('range', preset);
    next.delete('from');
    next.delete('to');
    setCustomOpen(false);
    push(next);
  }

  function applyCustom() {
    if (!from || !to || to < from) return;
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set('range', 'custom');
    next.set('from', from);
    next.set('to', to);
    push(next);
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', pending && 'opacity-70')}>
      <div className="inline-flex overflow-hidden rounded-full border border-slate-200 bg-white text-[12px] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        {DASHBOARD_RANGE_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => selectPreset(preset)}
            aria-pressed={range.preset === preset}
            className={cn(
              'px-2.5 py-1 font-medium transition',
              range.preset === preset
                ? 'bg-indigo-600 text-white'
                : 'text-slate-600 hover:bg-slate-50 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
            )}
          >
            {DASHBOARD_RANGE_SHORT_LABELS[preset]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          aria-pressed={range.preset === 'custom'}
          aria-expanded={customOpen}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 font-medium transition',
            range.preset === 'custom'
              ? 'bg-indigo-600 text-white'
              : 'text-slate-600 hover:bg-slate-50 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
          )}
        >
          <CalendarRange className="h-3.5 w-3.5" aria-hidden />
          Custom
        </button>
      </div>

      {customOpen ? (
        <div className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="Range start"
            className="bg-transparent text-[12px] text-slate-700 focus:outline-none dark:text-[#FAFAFA]"
          />
          <span className="text-slate-400 dark:text-[#71717A]">→</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            aria-label="Range end"
            className="bg-transparent text-[12px] text-slate-700 focus:outline-none dark:text-[#FAFAFA]"
          />
          <button
            type="button"
            onClick={applyCustom}
            disabled={!from || !to || to < from}
            className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      ) : null}

      <span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
        {range.label}
      </span>
    </div>
  );
}
