import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Shared KPI tile primitive. One component for every "label + big
 * number + small hint" block across the app. Tone drives both the
 * border tint and the value color so the same status semantics read
 * the same way everywhere (Email Engagement, Forecast, Pipeline,
 * future Executive dashboard, etc.).
 *
 * Why a shared primitive: before this, every report invented its own
 * tile JSX. With 5 reports already shipping and the executive
 * dashboard about to land, that's ~10 places we'd have to update for
 * any visual tweak. One component, one source of truth.
 *
 * Layout invariant: always renders at 3-line height (label / value /
 * hint) so grids of tiles line up vertically even when individual
 * hint text differs in length. The `hint` falls back to a non-
 * breaking space when missing.
 */
export type MetricTone =
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral';

export function MetricCard({
  label,
  value,
  hint,
  tone = 'neutral',
  trend,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTone;
  /** Optional small trend indicator slot (e.g. `+12%` arrow). */
  trend?: ReactNode;
  className?: string;
}) {
  const toneClass: Record<MetricTone, string> = {
    info: 'border-indigo-200 bg-indigo-50/30',
    success: 'border-emerald-200 bg-emerald-50/30',
    warning: 'border-amber-200 bg-amber-50/30',
    danger: 'border-rose-200 bg-rose-50/30',
    neutral: 'border-slate-200 bg-white',
  };
  const valueTone: Record<MetricTone, string> = {
    info: 'text-indigo-700',
    success: 'text-emerald-700',
    warning: 'text-amber-800',
    danger: 'text-rose-700',
    neutral: 'text-slate-900',
  };

  return (
    <div
      className={cn(
        'rounded-md border p-3 transition-shadow hover:shadow-sm',
        toneClass[tone],
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </span>
        {trend ?? null}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold tabular-nums leading-tight',
          valueTone[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-1 truncate text-[10.5px] text-slate-500">
        {hint ?? ' '}
      </div>
    </div>
  );
}

/**
 * Companion trend pill — `+12%` / `−4%` style indicator. Pass to
 * `<MetricCard trend={...} />`.
 */
export function TrendIndicator({
  delta,
  label,
}: {
  /** Positive = up, negative = down. 0 hides. */
  delta: number;
  /** Optional context (e.g. "vs last 30d"). Shown in title. */
  label?: string;
}) {
  if (delta === 0) return null;
  const positive = delta > 0;
  return (
    <span
      title={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold tabular-nums',
        positive
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-rose-100 text-rose-700',
      )}
    >
      {positive ? '↑' : '↓'}
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}
