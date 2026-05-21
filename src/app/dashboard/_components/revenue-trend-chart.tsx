'use client';

import { TrendingUp } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { RevenueTrend } from '@/lib/dashboard/queries';
import { cn } from '@/lib/utils';

/**
 * Revenue Trend Chart — the new hero. Replaces the giant trapezoid
 * funnel with a Stripe/Linear/Attio-style area chart:
 *
 *   - smooth monotone curves (Recharts' `monotone` interpolation
 *     gives the soft S-bend the references use, vs `natural` which
 *     overshoots and `linear` which looks angular)
 *   - layered area fills using SVG `<defs>` linearGradients
 *   - subtle dotted-grid + understated axis ticks
 *   - dark glassy tooltip on hover
 *
 * Three series:
 *   wonRevenue   (emerald, area + line)  - what closed-won that day
 *   newPipeline  (indigo,  area + line)  - what got added that day
 *   lostRevenue  (rose,    line only)    - context band, no fill
 *
 * Three-stage state machine:
 *   - empty (no points or all-zero) → empty state card
 *   - partial → still chart-it; sparse days fill at 0
 *   - full → standard render
 *
 * Currency formatting is handled by the parent via `formatCurrency`
 * so the chart stays tenant-currency aware.
 */
export function RevenueTrendChart({
  data,
  currency,
  title = 'Revenue trend',
  subtitle,
  className,
  showWeightedLine = false,
  totals,
}: {
  data: RevenueTrend;
  /**
   * Tenant currency context — three serializable scalars
   * (defaultCurrency, currencyLocale, compactNumbers). We can't pass
   * a `formatCurrency` *function* from a server component into this
   * client component because functions don't cross the RSC boundary
   * unless they're marked 'use server'. Passing the context lets us
   * construct the formatter inside, using the shared
   * `formatTenantCurrency` helper.
   */
  currency: TenantCurrencyContext;
  title?: string;
  subtitle?: string;
  className?: string;
  /** Reserved for future weighted-pipeline overlay; off by default. */
  showWeightedLine?: boolean;
  /** Optional header KPI strip. Each entry has a label + formatted value. */
  totals?: Array<{
    label: string;
    value: string;
    accent?: 'emerald' | 'indigo' | 'violet' | 'rose' | 'slate';
    sub?: string;
  }>;
}) {
  void showWeightedLine;

  // `data.points` carries amounts in MAJOR units; the tenant helpers
  // expect MINOR units, so we multiply by 100 before formatting.
  // Memoize the formatter so React keeps the same reference for the
  // chart's useMemo deps.
  const formatCurrency = useCallback(
    (amountMajor: number) =>
      currency.compactNumbers
        ? formatCompactTenantCurrency(Math.round(amountMajor * 100), currency)
        : formatTenantCurrency(Math.round(amountMajor * 100), currency),
    [currency],
  );

  const formatted = useMemo(
    () =>
      data.points.map((p) => ({
        ...p,
        // Pre-format the date label so the X-axis can stay terse
        // ("Sep 12") without doing string work on every tick render.
        label: shortDate(p.day),
      })),
    [data.points],
  );

  const hasAnyRevenue = formatted.some(
    (p) => p.wonRevenue > 0 || p.newPipeline > 0 || p.lostRevenue > 0,
  );

  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <TrendingUp className="h-3 w-3" aria-hidden />
            {data.days}-day trend
          </div>
          <h2 className="mt-2 text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {totals && totals.length > 0 ? (
          <div className="flex flex-wrap items-stretch gap-4">
            {totals.map((t) => (
              <KpiInline
                key={t.label}
                label={t.label}
                value={t.value}
                sub={t.sub}
                accent={t.accent ?? 'slate'}
              />
            ))}
          </div>
        ) : null}
      </header>

      <div className="px-2 py-4 sm:px-3">
        {!hasAnyRevenue ? (
          <div className="m-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-12 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
            No revenue activity in the last {data.days} days. Once deals start
            moving, the trend will fill in here automatically.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={formatted}
              margin={{ top: 6, right: 16, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="rtc-won" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="rtc-new" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 4"
                stroke="rgba(148, 163, 184, 0.25)"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) =>
                  formatCompactAxis(Number(v), formatCurrency)
                }
                width={56}
              />
              <Tooltip
                cursor={{ stroke: 'rgba(99,102,241,0.35)', strokeWidth: 1 }}
                content={(props) => {
                  // Recharts 3 has notoriously narrow tooltip generics;
                  // we inspect props at runtime and bail if shape is off.
                  const { active, payload } = props as unknown as {
                    active?: boolean;
                    payload?: ReadonlyArray<{ payload?: TrendDatum }>;
                  };
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0]?.payload;
                  if (!p) return null;
                  return (
                    <TrendTooltip datum={p} formatCurrency={formatCurrency} />
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="newPipeline"
                stroke="#6366f1"
                strokeWidth={1.75}
                fill="url(#rtc-new)"
                animationDuration={550}
                animationEasing="ease-out"
                isAnimationActive
              />
              <Area
                type="monotone"
                dataKey="wonRevenue"
                stroke="#10b981"
                strokeWidth={1.75}
                fill="url(#rtc-won)"
                animationDuration={650}
                animationEasing="ease-out"
                isAnimationActive
              />
              <Line
                type="monotone"
                dataKey="lostRevenue"
                stroke="#f43f5e"
                strokeWidth={1.25}
                strokeDasharray="4 4"
                dot={false}
                animationDuration={750}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-5 py-2.5 text-[11px] dark:border-[#1F1F1F]">
        <Legend dotClassName="bg-emerald-500" label="Won revenue" />
        <Legend dotClassName="bg-indigo-500" label="New pipeline" />
        <Legend dotClassName="bg-rose-500" label="Lost revenue" dashed />
      </footer>
    </section>
  );
}

/* ============================================================ */

function KpiInline({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: 'emerald' | 'indigo' | 'violet' | 'rose' | 'slate';
}) {
  const valueClass = {
    emerald: 'text-emerald-700 dark:text-emerald-300',
    indigo: 'text-indigo-700 dark:text-indigo-300',
    violet: 'text-violet-700 dark:text-violet-300',
    rose: 'text-rose-700 dark:text-rose-300',
    slate: 'text-slate-900 dark:text-[#FAFAFA]',
  }[accent];
  return (
    <div className="min-w-0 max-w-[10rem]">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div
        className={cn(
          'mt-0.5 truncate font-mono text-[17px] font-semibold tabular-nums',
          valueClass,
        )}
        title={value}
      >
        {value}
      </div>
      {sub ? (
        <div className="truncate text-[10px] text-slate-500 dark:text-[#A1A1AA]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Legend({
  dotClassName,
  label,
  dashed,
}: {
  dotClassName: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1.5 text-slate-600 dark:text-[#A1A1AA]">
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          dotClassName,
          dashed && 'opacity-70',
        )}
        aria-hidden
      />
      <span>{label}</span>
    </div>
  );
}

/* ============================================================ */
/* Tooltip                                                       */
/* ============================================================ */

type TrendDatum = {
  day: string;
  label: string;
  wonRevenue: number;
  newPipeline: number;
  lostRevenue: number;
};

function TrendTooltip({
  datum,
  formatCurrency,
}: {
  datum: TrendDatum;
  formatCurrency: (n: number) => string;
}) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 text-[11px] text-slate-100 shadow-xl backdrop-blur-md ring-1 ring-black/5"
    >
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-300">
        {longDate(datum.day)}
      </div>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
        <TooltipRow
          label="Won"
          value={formatCurrency(datum.wonRevenue)}
          dotClassName="bg-emerald-400"
        />
        <TooltipRow
          label="New pipeline"
          value={formatCurrency(datum.newPipeline)}
          dotClassName="bg-indigo-400"
        />
        <TooltipRow
          label="Lost"
          value={formatCurrency(datum.lostRevenue)}
          dotClassName="bg-rose-400"
          dashed
        />
      </dl>
    </div>
  );
}

function TooltipRow({
  label,
  value,
  dotClassName,
  dashed,
}: {
  label: string;
  value: string;
  dotClassName: string;
  dashed?: boolean;
}) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-slate-300">
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            dotClassName,
            dashed && 'opacity-70',
          )}
          aria-hidden
        />
        {label}
      </dt>
      <dd className="text-right text-slate-100">{value}</dd>
    </>
  );
}

/* ============================================================ */
/* helpers                                                       */
/* ============================================================ */

function shortDate(iso: string): string {
  // ISO yyyy-mm-dd → "Sep 12"
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatCompactAxis(
  v: number,
  formatCurrency: (n: number) => string,
): string {
  // Try a compact representation first (K / M / B); fall back to the
  // tenant currency formatter when the value is small.
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  if (v === 0) return '0';
  return formatCurrency(v);
}
