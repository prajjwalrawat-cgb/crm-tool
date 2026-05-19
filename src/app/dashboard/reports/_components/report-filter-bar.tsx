'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { DATE_RANGE_PRESET_LABELS } from '@/lib/reports/filters';
import type { DateRangePreset } from '@/lib/reports/types';
import { cn } from '@/lib/utils';

const DATE_PRESETS: DateRangePreset[] = [
  'last_7d',
  'last_30d',
  'last_90d',
  'this_quarter',
  'this_year',
  'all_time',
];

/**
 * URL-synced filter bar. Three filter groups, each independently
 * supported per-report via the `supports*` flags. Server is the source
 * of truth — every change kicks a `router.replace` so the report's
 * runner re-runs with the new params.
 */
export function ReportFilterBar({
  reportId,
  currentOwner,
  currentMode,
  currentRange,
  supportsOwnerScope,
  supportsMode,
  supportsDateRange,
}: {
  reportId: string;
  currentOwner: 'all' | 'mine';
  currentMode: 'count' | 'amount';
  currentRange: DateRangePreset;
  supportsOwnerScope: boolean;
  supportsMode: boolean;
  supportsDateRange: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set(key, value);
    start(() => {
      router.replace(`/dashboard/reports/${reportId}?${next.toString()}`);
    });
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        pending && 'opacity-70',
      )}
    >
      {supportsOwnerScope ? (
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
          {(['all', 'mine'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setParam('owner', v)}
              className={cn(
                'px-3 py-1 transition',
                currentOwner === v
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
            >
              {v === 'all' ? 'All deals' : 'My deals'}
            </button>
          ))}
        </div>
      ) : null}

      {supportsMode ? (
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
          {(['amount', 'count'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setParam('mode', v)}
              className={cn(
                'px-3 py-1 transition',
                currentMode === v
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
            >
              {v === 'amount' ? 'By value' : 'By count'}
            </button>
          ))}
        </div>
      ) : null}

      {supportsDateRange ? (
        <div className="inline-flex overflow-hidden rounded-md border border-slate-200 bg-white text-[12px]">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setParam('range', preset)}
              className={cn(
                'px-2.5 py-1 transition',
                currentRange === preset
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-700 hover:bg-slate-50',
              )}
              title={DATE_RANGE_PRESET_LABELS[preset]}
            >
              {shortLabel(preset)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function shortLabel(preset: DateRangePreset): string {
  switch (preset) {
    case 'today':
      return 'Today';
    case 'last_7d':
      return '7d';
    case 'last_30d':
      return '30d';
    case 'last_90d':
      return '90d';
    case 'this_quarter':
      return 'QTD';
    case 'this_year':
      return 'YTD';
    case 'all_time':
      return 'All';
  }
}
