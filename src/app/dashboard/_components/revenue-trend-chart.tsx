'use client';

import { Settings2, TrendingUp } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  CHART_KEY_REVENUE_TREND,
  DEFAULT_REVENUE_TREND_CONFIG,
  type RevenueTrendConfig,
  type RevenueTrendVariant,
} from '@/lib/chart-studio/config';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { RevenueTrend } from '@/lib/dashboard/queries';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

import { ChartStudioPanel } from './chart-studio/chart-studio-panel';

/**
 * Revenue Trend Chart — Stripe/Linear/Attio-style area chart, now
 * with the hidden "Chart Studio" config surface. Normal users see a
 * polished chart with no controls. Power users press Cmd/Ctrl+K
 * while the chart is focused (or click the small icon that appears
 * on hover) to open the Studio.
 *
 * Stateful: the chart owns its live config so Studio toggles preview
 * instantly. Save persists via server action; Reset restores the
 * baseline default. The `initialConfig` prop carries any DB-saved
 * config the user already had, so the page-load render matches.
 *
 * Variants: area (default) · stacked-area · line · bar. Display
 * options drive smoothness, animation, lost-line visibility,
 * cumulative view, and KPI band compactness.
 */
export function RevenueTrendChart({
  data,
  currency,
  title: defaultTitle = 'Revenue trend',
  subtitle,
  className,
  totals,
  initialConfig,
  initialTitleOverride,
  persona,
}: {
  data: RevenueTrend;
  currency: TenantCurrencyContext;
  title?: string;
  subtitle?: string;
  className?: string;
  totals?: Array<{
    label: string;
    value: string;
    accent?: 'emerald' | 'indigo' | 'violet' | 'rose' | 'slate';
    sub?: string;
  }>;
  /** Saved chart config from DB; null = use defaults. */
  initialConfig?: RevenueTrendConfig | null;
  /** Saved custom title; null = use default. */
  initialTitleOverride?: string | null;
  /** Drives scope selector visibility in the Studio. */
  persona: Persona;
}) {
  const headingId = useId();
  const chartFrameRef = useRef<HTMLElement>(null);

  // Live config — Studio toggles update this for instant preview;
  // Save persists it. Reset re-initializes from the default.
  const [config, setConfig] = useState<RevenueTrendConfig>(
    initialConfig ?? DEFAULT_REVENUE_TREND_CONFIG,
  );
  const [titleOverride, setTitleOverride] = useState<string | null>(
    initialTitleOverride ?? null,
  );
  const [studioOpen, setStudioOpen] = useState(false);

  // Track whether the chart frame has focus — Cmd/Ctrl+K only opens
  // the studio when the chart is the active region, not whenever the
  // shortcut fires globally (that's reserved for the command palette).
  const [chartFocused, setChartFocused] = useState(false);

  // Cmd/Ctrl+K → toggle Studio. We capture at the window level so the
  // shortcut works whether the chart itself has DOM focus or the focus
  // moved to an inner control (Studio button, axis hover area, etc.)
  // BUT we gate on `chartFocused` so we don't conflict with the global
  // ⌘K palette listener in the dashboard shell.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!chartFocused && !studioOpen) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      // If focus is inside an input/textarea (e.g. the rename field
      // inside the open studio), let the user type cmd-arrows etc.
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setStudioOpen((prev) => !prev);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [chartFocused, studioOpen]);

  // `data.points` carries amounts in MAJOR units; the tenant helpers
  // expect MINOR units, so we multiply by 100 before formatting.
  const formatCurrency = useCallback(
    (amountMajor: number) =>
      currency.compactNumbers
        ? formatCompactTenantCurrency(Math.round(amountMajor * 100), currency)
        : formatTenantCurrency(Math.round(amountMajor * 100), currency),
    [currency],
  );

  // Pre-shape data per the cumulative toggle. Running totals are
  // computed on the client to avoid re-fetching from the server.
  const formatted = useMemo(() => {
    const base = data.points.map((p) => ({
      ...p,
      label: shortDate(p.day),
    }));
    if (!config.display.cumulative) return base;
    let won = 0;
    let neu = 0;
    let lost = 0;
    return base.map((p) => {
      won += p.wonRevenue;
      neu += p.newPipeline;
      lost += p.lostRevenue;
      return {
        ...p,
        wonRevenue: won,
        newPipeline: neu,
        lostRevenue: lost,
      };
    });
  }, [data.points, config.display.cumulative]);

  const hasAnyRevenue = formatted.some(
    (p) => p.wonRevenue > 0 || p.newPipeline > 0 || p.lostRevenue > 0,
  );

  const title = (titleOverride?.trim() || defaultTitle).trim();

  return (
    <>
      <section
        ref={chartFrameRef}
        tabIndex={0}
        role="region"
        aria-labelledby={headingId}
        aria-describedby={undefined}
        onFocus={() => setChartFocused(true)}
        onBlur={(e) => {
          // Only blur the chart-frame state when focus actually leaves
          // the section, not when it moves to a descendant.
          if (
            !e.currentTarget.contains(e.relatedTarget as Node | null) &&
            !studioOpen
          ) {
            setChartFocused(false);
          }
        }}
        className={cn(
          'group/chart relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] outline-none transition-shadow focus-within:shadow-[0_0_0_2px_rgba(99,102,241,0.18)] focus-within:ring-1 focus-within:ring-indigo-400/30 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
          className,
        )}
      >
        <header
          className={cn(
            'flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 dark:border-[#1F1F1F]',
            config.display.compact ? 'px-5 py-3' : 'px-5 py-4',
          )}
        >
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <TrendingUp className="h-3 w-3" aria-hidden />
              {data.days}-day trend
            </div>
            <h2
              id={headingId}
              className="mt-2 truncate text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]"
            >
              {title}
            </h2>
            {subtitle && !config.display.compact ? (
              <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                {subtitle}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-stretch gap-4">
            {totals && totals.length > 0
              ? totals.map((t) => (
                  <KpiInline
                    key={t.label}
                    label={t.label}
                    value={t.value}
                    sub={t.sub}
                    accent={t.accent ?? 'slate'}
                  />
                ))
              : null}
            {/* Discreet Studio launcher — visible only on hover/focus
                so the default chrome stays clean. Power users who know
                the keyboard shortcut never need to see this. */}
            <button
              type="button"
              onClick={() => setStudioOpen(true)}
              aria-label="Open Chart Studio (Cmd/Ctrl+K)"
              title="Chart Studio · ⌘K"
              className="self-start rounded-md border border-transparent p-1 text-slate-400 opacity-0 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 group-hover/chart:opacity-100 group-focus-within/chart:opacity-100 dark:hover:border-[#1F1F1F] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </header>

        <div className={cn(config.display.compact ? 'px-2 py-3' : 'px-2 py-4', 'sm:px-3')}>
          {!hasAnyRevenue ? (
            <div className="m-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-12 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
              No revenue activity in the last {data.days} days. Once deals start
              moving, the trend will fill in here automatically.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <ChartBody
                variant={config.variant}
                data={formatted}
                display={config.display}
                formatCurrency={formatCurrency}
              />
            </ResponsiveContainer>
          )}
        </div>

        {config.display.showLegend ? (
          <footer className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-5 py-2.5 text-[11px] dark:border-[#1F1F1F]">
            <Legend dotClassName="bg-emerald-500" label="Won revenue" />
            <Legend dotClassName="bg-indigo-500" label="New pipeline" />
            {config.display.showLostLine ? (
              <Legend dotClassName="bg-rose-500" label="Lost revenue" dashed />
            ) : null}
            <span className="ml-auto hidden text-[10px] text-slate-400 sm:inline dark:text-[#71717A]">
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono dark:border-[#1F1F1F] dark:bg-[#111111]">
                ⌘K
              </kbd>{' '}
              while focused → Chart Studio
            </span>
          </footer>
        ) : null}
      </section>

      <ChartStudioPanel
        chartKey={CHART_KEY_REVENUE_TREND}
        chartTitle={defaultTitle}
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
        config={config}
        onConfigChange={setConfig}
        titleOverride={titleOverride}
        onTitleChange={setTitleOverride}
        persona={persona}
      />
    </>
  );
}

/* ============================================================ */
/* Chart body — switches by variant                              */
/* ============================================================ */

type ChartBodyDatum = {
  day: string;
  label: string;
  wonRevenue: number;
  newPipeline: number;
  lostRevenue: number;
};

function ChartBody({
  variant,
  data,
  display,
  formatCurrency,
}: {
  variant: RevenueTrendVariant;
  data: ChartBodyDatum[];
  display: RevenueTrendConfig['display'];
  formatCurrency: (n: number) => string;
}) {
  const curve = display.smoothLines ? 'monotone' : 'linear';
  const isStacked = variant === 'stacked-area';

  const commonAxes = (
    <>
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
        tickFormatter={(v) => formatCompactAxis(Number(v), formatCurrency)}
        width={56}
      />
      <Tooltip
        cursor={{ stroke: 'rgba(99,102,241,0.35)', strokeWidth: 1 }}
        content={(props) => {
          const { active, payload } = props as unknown as {
            active?: boolean;
            payload?: ReadonlyArray<{ payload?: ChartBodyDatum }>;
          };
          if (!active || !payload || payload.length === 0) return null;
          const p = payload[0]?.payload;
          if (!p) return null;
          return (
            <TrendTooltip
              datum={p}
              formatCurrency={formatCurrency}
              showLost={display.showLostLine}
            />
          );
        }}
      />
    </>
  );

  if (variant === 'line') {
    return (
      <LineChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
        {commonAxes}
        <Line
          type={curve}
          dataKey="newPipeline"
          stroke="#6366f1"
          strokeWidth={1.75}
          dot={false}
          animationDuration={550}
          animationEasing="ease-out"
          isAnimationActive={display.animated}
        />
        <Line
          type={curve}
          dataKey="wonRevenue"
          stroke="#10b981"
          strokeWidth={1.75}
          dot={false}
          animationDuration={650}
          animationEasing="ease-out"
          isAnimationActive={display.animated}
        />
        {display.showLostLine ? (
          <Line
            type={curve}
            dataKey="lostRevenue"
            stroke="#f43f5e"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            dot={false}
            animationDuration={750}
            animationEasing="ease-out"
            isAnimationActive={display.animated}
          />
        ) : null}
      </LineChart>
    );
  }

  if (variant === 'bar') {
    return (
      <BarChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
        {commonAxes}
        <Bar
          dataKey="newPipeline"
          fill="#6366f1"
          fillOpacity={0.7}
          radius={[2, 2, 0, 0]}
          isAnimationActive={display.animated}
        />
        <Bar
          dataKey="wonRevenue"
          fill="#10b981"
          fillOpacity={0.85}
          radius={[2, 2, 0, 0]}
          isAnimationActive={display.animated}
        />
        {display.showLostLine ? (
          <Bar
            dataKey="lostRevenue"
            fill="#f43f5e"
            fillOpacity={0.55}
            radius={[2, 2, 0, 0]}
            isAnimationActive={display.animated}
          />
        ) : null}
      </BarChart>
    );
  }

  // area & stacked-area
  return (
    <AreaChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
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
      {commonAxes}
      <Area
        type={curve}
        dataKey="newPipeline"
        stackId={isStacked ? 'rev' : undefined}
        stroke="#6366f1"
        strokeWidth={1.75}
        fill="url(#rtc-new)"
        animationDuration={550}
        animationEasing="ease-out"
        isAnimationActive={display.animated}
      />
      <Area
        type={curve}
        dataKey="wonRevenue"
        stackId={isStacked ? 'rev' : undefined}
        stroke="#10b981"
        strokeWidth={1.75}
        fill="url(#rtc-won)"
        animationDuration={650}
        animationEasing="ease-out"
        isAnimationActive={display.animated}
      />
      {display.showLostLine ? (
        <Line
          type={curve}
          dataKey="lostRevenue"
          stroke="#f43f5e"
          strokeWidth={1.25}
          strokeDasharray="4 4"
          dot={false}
          animationDuration={750}
          animationEasing="ease-out"
          isAnimationActive={display.animated}
        />
      ) : null}
    </AreaChart>
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

function TrendTooltip({
  datum,
  formatCurrency,
  showLost,
}: {
  datum: ChartBodyDatum;
  formatCurrency: (n: number) => string;
  showLost: boolean;
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
        {showLost ? (
          <TooltipRow
            label="Lost"
            value={formatCurrency(datum.lostRevenue)}
            dotClassName="bg-rose-400"
            dashed
          />
        ) : null}
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
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  if (v === 0) return '0';
  return formatCurrency(v);
}
