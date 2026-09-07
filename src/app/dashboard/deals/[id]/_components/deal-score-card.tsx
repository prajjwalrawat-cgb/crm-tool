'use client';

import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

import { cn } from '@/lib/utils';

type Reason = { signal: string; delta: number; detail: string };
type Point = { score: number; computedAt: string };

const BAND_META: Record<
  string,
  { label: string; text: string; ring: string; stroke: string }
> = {
  strong: {
    label: 'Strong',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-500/30',
    stroke: '#10b981',
  },
  moderate: {
    label: 'Moderate',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-400/30',
    stroke: '#f59e0b',
  },
  at_risk: {
    // "Weak", not "At risk": the Deal risk card on this same page has its own
    // bands, and a deal reading "At risk" for health while reading "Low risk"
    // beside it is two opposite meanings for one word, six inches apart. The
    // stored band value is untouched.
    label: 'Weak',
    text: 'text-rose-600 dark:text-rose-400',
    ring: 'ring-rose-500/30',
    stroke: '#f43f5e',
  },
};

/**
 * Deal Score card (Module 2) — the number, its band, a sparkline of history
 * (when ≥3 points), and the top positive / negative reasons in plain language.
 * Purely presentational: all values come pre-computed from the server.
 */
export function DealScoreCard({
  score,
  band,
  reasons,
  history,
}: {
  score: number;
  band: string;
  reasons: Reason[];
  /** Newest-first history points (as returned by the service). */
  history: Point[];
}) {
  const meta = BAND_META[band] ?? BAND_META.moderate!;

  const positives = reasons
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);
  const negatives = reasons
    .filter((r) => r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 3);

  // Chronological order for the sparkline.
  const series = [...history].reverse().map((p, i) => ({ i, score: p.score }));

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="flex items-start justify-between">
        <div>
          {/* "Deal Score" alone was ambiguous the moment a second 0-100
              number landed on this page pointing the other way. The name says
              what it measures and the line under it says which direction is
              good — neither is inferable from the number or its colour. */}
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
            Deal health
          </h2>
          <p className="mt-0.5 text-[11px] normal-case tracking-normal text-slate-400 dark:text-[#71717A]">
            Higher is better · engagement, stakeholders, tasks
          </p>
        </div>
        <span className={cn('text-[11px] font-semibold', meta.text)}>
          {meta.label}
        </span>
      </div>

      <div className="mt-2 flex items-end gap-3">
        <div
          className={cn(
            'flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-2xl font-bold ring-4',
            meta.text,
            meta.ring,
          )}
        >
          {score}
        </div>
        {series.length >= 3 ? (
          <div className="h-14 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 6, bottom: 6, left: 0, right: 0 }}>
                <YAxis domain={[0, 100]} hide />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke={meta.stroke}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="pb-1 text-[11px] text-slate-400">
            Trend appears after a few recomputes.
          </p>
        )}
      </div>

      <div className="mt-3 space-y-2">
        {positives.length > 0 ? (
          <ReasonGroup title="Working for it" reasons={positives} kind="up" />
        ) : null}
        {negatives.length > 0 ? (
          <ReasonGroup title="Dragging it down" reasons={negatives} kind="down" />
        ) : null}
        {positives.length === 0 && negatives.length === 0 ? (
          <p className="text-[12px] text-slate-400">
            Baseline score — no strong signals either way yet.
          </p>
        ) : null}
      </div>
    </article>
  );
}

function ReasonGroup({
  title,
  reasons,
  kind,
}: {
  title: string;
  reasons: Reason[];
  kind: 'up' | 'down';
}) {
  const Icon = kind === 'up' ? TrendingUp : TrendingDown;
  const color = kind === 'up' ? 'text-emerald-500' : 'text-rose-500';
  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        <Icon className={cn('h-3 w-3', color)} /> {title}
      </div>
      <ul className="space-y-0.5">
        {reasons.map((r, i) => (
          <li
            key={`${r.signal}-${i}`}
            className="flex items-center justify-between gap-2 text-[12px] text-slate-600 dark:text-[#D4D4D8]"
          >
            <span className="flex items-center gap-1.5">
              <Minus className="h-3 w-3 text-transparent" aria-hidden />
              {r.detail}
            </span>
            <span
              className={cn(
                'shrink-0 font-mono text-[11px] font-medium',
                r.delta > 0 ? 'text-emerald-600' : 'text-rose-600',
              )}
            >
              {r.delta > 0 ? `+${r.delta}` : r.delta}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
