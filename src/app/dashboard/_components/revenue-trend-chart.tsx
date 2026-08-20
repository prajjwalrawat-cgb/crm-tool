'use client';

import { Settings2, TrendingUp } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  DEFAULT_REVENUE_TREND_CONFIG,
  REVENUE_TREND_METRICS,
  type RevenueTrendConfig,
  type RevenueTrendMetric,
  type RevenueTrendVariant,
} from '@/lib/chart-studio/config';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { RevenueTrend } from '@/lib/dashboard/queries';
import {
  buildWeekly,
  type WeeklyData,
  type WeeklyPoint,
} from '@/lib/dashboard/trend-shaping';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

import { ChartStudioPanel } from './chart-studio/chart-studio-panel';
import { useStudioRegistration } from './edit-mode/edit-mode-context';

/**
 * Revenue Trend Chart — premium hero with hidden Chart Studio. The
 * chart can render five variants (area · stacked-area · line · bar
 * · flutter) across four metrics (revenue · deal count · avg deal
 * size · conversion rate). All changes apply live; the saved view
 * persists to the chart_views table per user.
 *
 * Flutter mode: animated flowing curve. Implemented via a layered
 * area chart + CSS keyframes on a wrapper div that "breathes" the
 * drop-shadow + a slow horizontal pan on the gradient overlay. Pure
 * CSS, no Recharts surgery — the chart geometry is identical to
 * area mode; only the visual treatment differs.
 *
 * Metric semantics:
 *   revenue        → won / new pipeline / lost (currency, multi-series)
 *   dealCount      → wonDeals / newDeals / lostDeals (count, multi-series)
 *   avgDealSize    → won_revenue / won_deals per day (currency, single series)
 *   conversionRate → cumulative won / (won + lost) ratio (percentage, single series)
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
  initialConfig?: RevenueTrendConfig | null;
  initialTitleOverride?: string | null;
  persona: Persona;
}) {
  const headingId = useId();
  const chartFrameRef = useRef<HTMLElement>(null);

  const [config, setConfig] = useState<RevenueTrendConfig>(
    initialConfig ?? DEFAULT_REVENUE_TREND_CONFIG,
  );
  const [titleOverride, setTitleOverride] = useState<string | null>(
    initialTitleOverride ?? null,
  );
  const [studioOpen, setStudioOpen] = useState(false);
  const [chartFocused, setChartFocused] = useState(false);

  // Register with EditModeContext so the CopilotPanel auto-hides
  // while this chart's Studio is open.
  useStudioRegistration(studioOpen);

  // Cmd/Ctrl+E toggles Studio when the chart is the active region.
  // Moved off ⌘K because that's the conventional global-search /
  // command-palette shortcut — users hit it to search and accidentally
  // opened the wrong surface. ⌘E is rarely bound in browsers/CRMs and
  // reads naturally as "Edit chart".
  //
  // Still gated on `chartFocused || studioOpen` so other regions of
  // the page can use the shortcut for their own purposes without
  // hijacking the active chart.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'e' && e.key !== 'E') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (!chartFocused && !studioOpen) return;
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable) return;
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

  // Currency formatter — built from tenant context so the chart works
  // across personas without function props crossing the RSC boundary.
  const formatCurrency = useCallback(
    (amountMajor: number) =>
      currency.compactNumbers
        ? formatCompactTenantCurrency(Math.round(amountMajor * 100), currency)
        : formatTenantCurrency(Math.round(amountMajor * 100), currency),
    [currency],
  );

  // Pre-shape the data based on the selected metric. Each metric yields
  // a different field set on each point so the chart body can render
  // generically (it reads `seriesA`/`seriesB`/`seriesC` rather than
  // metric-specific keys).
  const shaped = useMemo(
    () => shapeForMetric(data.points, config.metric, config.display.cumulative),
    [data.points, config.metric, config.display.cumulative],
  );

  // Weekly + dual-axis view. Only meaningful for the multi-series
  // metrics (revenue / deal count) — an averaged or cumulative-ratio
  // metric has nothing to put on the second axis, so those fall back
  // to the area renderer even when `weekly` is the saved variant.
  const weekly = useMemo(
    () =>
      config.variant === 'weekly' && isMultiSeries(config.metric)
        ? buildWeekly(shaped.points, config.display.cumulative)
        : null,
    [config.variant, config.metric, config.display.cumulative, shaped.points],
  );

  // Axis capping used to announce itself in an always-on amber banner
  // above the chart ("N weeks exceed the won/lost axis. Hover the
  // marked point for real value."). That is console-note phrasing —
  // it read as leaked debug output sitting permanently on the
  // dashboard, and it duplicated information the chart already
  // conveys in place: a capped bar draws a torn top edge and that
  // week's tooltip states the figures shown are the real ones.
  //
  // The diagnostic still exists, it just goes where diagnostics go.
  // Dev only — `process.env.NODE_ENV` is inlined at build time, so
  // this whole block is dead code in a production bundle.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    if (!weekly?.devNotices.length) return;
    console.warn(
      `[revenue-trend] axis capped — ${weekly.devNotices.join(' ')}`,
    );
  }, [weekly]);

  const formatValue = useCallback(
    (v: number) => formatMetricValue(v, config.metric, formatCurrency),
    [config.metric, formatCurrency],
  );

  const formatAxis = useCallback(
    (v: number) => formatMetricAxis(v, config.metric, formatCurrency),
    [config.metric, formatCurrency],
  );

  const hasAnyData = shaped.points.some(
    (p) =>
      (typeof p.seriesA === 'number' && p.seriesA > 0) ||
      (typeof p.seriesB === 'number' && p.seriesB > 0) ||
      (typeof p.seriesC === 'number' && p.seriesC > 0),
  );

  const title = (titleOverride?.trim() || defaultTitle).trim();

  return (
    <>
      <section
        ref={chartFrameRef}
        tabIndex={0}
        role="region"
        aria-labelledby={headingId}
        onFocus={() => setChartFocused(true)}
        onBlur={(e) => {
          if (
            !e.currentTarget.contains(e.relatedTarget as Node | null) &&
            !studioOpen
          ) {
            setChartFocused(false);
          }
        }}
        className={cn(
          // Focus halo: subtle lift + outer drop-shadow + thin indigo
          // ring. transform-only animation means no layout shift to
          // surrounding cards (the ~1cm visual space the spec calls
          // out is the drop-shadow blur, not actual size).
          'group/chart relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] outline-none transition-all duration-200 focus-within:-translate-y-0.5 focus-within:shadow-[0_18px_38px_-18px_rgba(99,102,241,0.45),0_0_0_1px_rgba(99,102,241,0.18)] focus-within:ring-1 focus-within:ring-indigo-400/30 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
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
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <TrendingUp className="h-3 w-3" aria-hidden />
                {data.days}-day trend
              </div>
              <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
                {labelForMetric(config.metric)}
              </div>
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
            <button
              type="button"
              onClick={() => setStudioOpen(true)}
              aria-label="Open Chart Studio (Cmd/Ctrl+E)"
              title="Chart Studio · ⌘E"
              className="self-start rounded-md border border-transparent p-1 text-slate-400 opacity-0 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 group-hover/chart:opacity-100 group-focus-within/chart:opacity-100 dark:hover:border-[#1F1F1F] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </header>

        <div
          className={cn(
            'sm:px-3',
            config.display.compact ? 'px-2 py-3' : 'px-2 py-4',
            // Flutter mode wraps the chart in a "breathing" wrapper —
            // CSS keyframes handle the subtle glow pulse without any
            // Recharts-internal surgery. Keyframes are emitted once
            // below via a <style> tag.
            config.variant === 'flutter' && 'rtc-flutter-wrap',
          )}
        >
          {!hasAnyData ? (
            <div className="m-3 rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-4 py-12 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
              No {labelForMetric(config.metric).toLowerCase()} activity in the
              last {data.days} days. Once deals start moving, the trend will
              fill in here automatically.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={weekly ? 280 : 260}>
                <ChartBody
                  variant={config.variant}
                  shaped={shaped}
                  weekly={weekly}
                  display={config.display}
                  formatValue={formatValue}
                  formatAxis={formatAxis}
                />
              </ResponsiveContainer>
            </>
          )}
        </div>

        {config.display.showLegend ? (
          <footer className="flex flex-wrap items-center gap-4 border-t border-slate-200 px-5 py-2.5 text-[11px] dark:border-[#1F1F1F]">
            {shaped.series.map((s) => (
              <Legend
                key={s.key}
                dotClassName={s.dotClass}
                label={s.label}
                dashed={s.dashed}
              />
            ))}
            <span className="ml-auto hidden text-[10px] text-slate-400 sm:inline dark:text-[#71717A]">
              <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-px font-mono dark:border-[#1F1F1F] dark:bg-[#111111]">
                ⌘E
              </kbd>{' '}
              while focused → Chart Studio
            </span>
          </footer>
        ) : null}

        {/* Flutter keyframes — scoped via class so non-flutter charts
            don't pay the animation cost. Honors reduced-motion. */}
        <style>{`
          @keyframes rtc-flutter-breathe {
            0%, 100% { filter: drop-shadow(0 6px 16px rgba(99, 102, 241, 0.16)) drop-shadow(0 0 0 rgba(16, 185, 129, 0)); }
            50%      { filter: drop-shadow(0 10px 22px rgba(99, 102, 241, 0.28)) drop-shadow(0 0 12px rgba(16, 185, 129, 0.25)); }
          }
          @keyframes rtc-flutter-shimmer {
            0%   { transform: translateX(-12%); opacity: 0.18; }
            50%  { transform: translateX(0%); opacity: 0.30; }
            100% { transform: translateX(12%); opacity: 0.18; }
          }
          .rtc-flutter-wrap {
            position: relative;
            animation: rtc-flutter-breathe 4.5s ease-in-out infinite;
          }
          .rtc-flutter-wrap::after {
            content: '';
            position: absolute;
            inset: 0;
            pointer-events: none;
            background: linear-gradient(
              100deg,
              rgba(99, 102, 241, 0) 35%,
              rgba(99, 102, 241, 0.12) 50%,
              rgba(16, 185, 129, 0.12) 60%,
              rgba(16, 185, 129, 0) 75%
            );
            animation: rtc-flutter-shimmer 6s ease-in-out infinite;
            mix-blend-mode: screen;
          }
          @media (prefers-reduced-motion: reduce) {
            .rtc-flutter-wrap,
            .rtc-flutter-wrap::after {
              animation: none;
            }
          }
        `}</style>
      </section>

      <ChartStudioPanel
        chartTitle={defaultTitle}
        open={studioOpen}
        onClose={() => setStudioOpen(false)}
        config={config}
        onConfigChange={setConfig as Dispatch<SetStateAction<RevenueTrendConfig>>}
        titleOverride={titleOverride}
        onTitleChange={setTitleOverride}
        persona={persona}
      />
    </>
  );
}

/* ============================================================ */
/* Data shaping per metric                                       */
/* ============================================================ */

type ShapedSeries = {
  key: 'seriesA' | 'seriesB' | 'seriesC';
  label: string;
  color: string;
  dotClass: string;
  dashed?: boolean;
  /** Set to true to render as a line over the area chart (e.g. lost). */
  asLineOverride?: boolean;
};

type ShapedPoint = {
  day: string;
  label: string;
  seriesA: number;
  seriesB: number;
  seriesC: number;
};

type ShapedData = {
  series: ShapedSeries[];
  points: ShapedPoint[];
};

function shapeForMetric(
  points: Array<{
    day: string;
    wonRevenue: number;
    newPipeline: number;
    lostRevenue: number;
    wonDeals: number;
    newDeals: number;
    lostDeals: number;
  }>,
  metric: RevenueTrendMetric,
  cumulative: boolean,
): ShapedData {
  // Helper: project each input point into a 3-series shape with the
  // right labels for the chosen metric. seriesA = primary, seriesB =
  // secondary, seriesC = tertiary (often "lost" for context).
  let series: ShapedSeries[];
  let mapper: (p: (typeof points)[number]) => Omit<ShapedPoint, 'day' | 'label'>;

  switch (metric) {
    case 'dealCount': {
      series = [
        {
          key: 'seriesB',
          label: 'New deals',
          color: '#6366f1',
          dotClass: 'bg-indigo-500',
        },
        {
          key: 'seriesA',
          label: 'Won deals',
          color: '#10b981',
          dotClass: 'bg-emerald-500',
        },
        {
          key: 'seriesC',
          label: 'Lost deals',
          color: '#f43f5e',
          dotClass: 'bg-rose-500',
          dashed: true,
          asLineOverride: true,
        },
      ];
      mapper = (p) => ({
        seriesA: p.wonDeals,
        seriesB: p.newDeals,
        seriesC: p.lostDeals,
      });
      break;
    }
    case 'avgDealSize': {
      // Single-series — won_revenue / max(won_deals, 1). Daily
      // resolution. seriesB/C kept as 0 so the chart body's generic
      // renderer still has all three keys present.
      series = [
        {
          key: 'seriesA',
          label: 'Avg won deal size',
          color: '#10b981',
          dotClass: 'bg-emerald-500',
        },
      ];
      mapper = (p) => ({
        seriesA: p.wonDeals > 0 ? p.wonRevenue / p.wonDeals : 0,
        seriesB: 0,
        seriesC: 0,
      });
      break;
    }
    case 'conversionRate': {
      // Single-series, cumulative — running won / (won + lost) ratio.
      // The cumulative toggle is implied; we always compute running.
      series = [
        {
          key: 'seriesA',
          label: 'Conversion rate',
          color: '#10b981',
          dotClass: 'bg-emerald-500',
        },
      ];
      let cumWon = 0;
      let cumLost = 0;
      const shaped = points.map((p) => {
        cumWon += p.wonDeals;
        cumLost += p.lostDeals;
        const denom = cumWon + cumLost;
        const ratio = denom > 0 ? (cumWon / denom) * 100 : 0;
        return {
          day: p.day,
          label: shortDate(p.day),
          seriesA: ratio,
          seriesB: 0,
          seriesC: 0,
        };
      });
      return { series, points: shaped };
    }
    case 'revenue':
    default: {
      series = [
        {
          key: 'seriesB',
          label: 'New pipeline',
          color: '#6366f1',
          dotClass: 'bg-indigo-500',
        },
        {
          key: 'seriesA',
          label: 'Won revenue',
          color: '#10b981',
          dotClass: 'bg-emerald-500',
        },
        {
          key: 'seriesC',
          label: 'Lost revenue',
          color: '#f43f5e',
          dotClass: 'bg-rose-500',
          dashed: true,
          asLineOverride: true,
        },
      ];
      mapper = (p) => ({
        seriesA: p.wonRevenue,
        seriesB: p.newPipeline,
        seriesC: p.lostRevenue,
      });
      break;
    }
  }

  // Standard mapping (non-conversionRate paths).
  const mapped = points.map((p) => ({
    day: p.day,
    label: shortDate(p.day),
    ...mapper(p),
  }));

  if (!cumulative) return { series, points: mapped };
  // Running totals for revenue / dealCount; n/a for avgDealSize (
  // running avg would be misleading) — we skip it there.
  if (metric === 'avgDealSize') return { series, points: mapped };

  let a = 0;
  let b = 0;
  let c = 0;
  return {
    series,
    points: mapped.map((p) => {
      a += p.seriesA;
      b += p.seriesB;
      c += p.seriesC;
      return { ...p, seriesA: a, seriesB: b, seriesC: c };
    }),
  };
}

/* ============================================================ */
/* Weekly + dual-axis shaping                                    */
/* ============================================================ */

/**
 * Metrics that carry a "new" series AND an outcome pair. Only these
 * can be drawn as pipeline bars + won/lost overlay; the single-series
 * metrics have nothing for the second axis.
 *
 * The bucketing + outlier math itself lives in
 * `lib/dashboard/trend-shaping` so it can be unit-tested without
 * dragging Recharts into a script — see `scripts/selftest-dashboard.ts`.
 */
function isMultiSeries(m: RevenueTrendMetric): boolean {
  return m === 'revenue' || m === 'dealCount';
}

function labelForMetric(m: RevenueTrendMetric): string {
  return REVENUE_TREND_METRICS.find((x) => x.value === m)?.label ?? 'Revenue';
}

function formatMetricValue(
  v: number,
  metric: RevenueTrendMetric,
  formatCurrency: (n: number) => string,
): string {
  const meta = REVENUE_TREND_METRICS.find((x) => x.value === metric);
  if (meta?.isCurrency) return formatCurrency(v);
  if (meta?.isPercentage) return `${v.toFixed(1)}%`;
  return Math.round(v).toLocaleString();
}

function formatMetricAxis(
  v: number,
  metric: RevenueTrendMetric,
  formatCurrency: (n: number) => string,
): string {
  const meta = REVENUE_TREND_METRICS.find((x) => x.value === metric);
  if (meta?.isPercentage) return `${Math.round(v)}%`;
  if (meta?.isCurrency) {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v === 0) return '0';
    return formatCurrency(v);
  }
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Math.round(v).toLocaleString();
}

/* ============================================================ */
/* Chart body — variant switch                                   */
/* ============================================================ */

function ChartBody({
  variant,
  shaped,
  weekly,
  display,
  formatValue,
  formatAxis,
}: {
  variant: RevenueTrendVariant;
  shaped: ShapedData;
  /** Non-null only when the weekly dual-axis view applies. */
  weekly: WeeklyData | null;
  display: RevenueTrendConfig['display'];
  formatValue: (n: number) => string;
  formatAxis: (n: number) => string;
}) {
  if (variant === 'weekly' && weekly) {
    return (
      <WeeklyBody
        weekly={weekly}
        shaped={shaped}
        display={display}
        formatValue={formatValue}
        formatAxis={formatAxis}
      />
    );
  }

  const curve = display.smoothLines ? 'monotone' : 'linear';
  const isStacked = variant === 'stacked-area';
  // Flutter uses the area renderer but with stronger gradient stops +
  // a glowing active dot. The CSS shimmer + breathe wraps it.
  const isFlutter = variant === 'flutter';
  // `weekly` lands here only when the metric can't support the dual
  // axis (single-series metrics) — it falls back to the area look.
  const useAreaRenderer =
    variant === 'area' || variant === 'weekly' || isStacked || isFlutter;

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
        tickFormatter={(v) => formatAxis(Number(v))}
        width={56}
      />
      <Tooltip
        cursor={{ stroke: 'rgba(99,102,241,0.35)', strokeWidth: 1 }}
        content={(props) => {
          const { active, payload } = props as unknown as {
            active?: boolean;
            payload?: ReadonlyArray<{ payload?: ShapedPoint }>;
          };
          if (!active || !payload || payload.length === 0) return null;
          const p = payload[0]?.payload;
          if (!p) return null;
          return (
            <TrendTooltip
              datum={p}
              series={shaped.series.filter((s) =>
                s.key === 'seriesC' ? display.showLostLine : true,
              )}
              formatValue={formatValue}
            />
          );
        }}
      />
    </>
  );

  // Series filter — collapse the lost series when the toggle is off.
  const visibleSeries = shaped.series.filter((s) =>
    s.key === 'seriesC' ? display.showLostLine : true,
  );

  if (variant === 'line') {
    return (
      <LineChart data={shaped.points} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
        {commonAxes}
        {visibleSeries.map((s) => (
          <Line
            key={s.key}
            type={curve}
            dataKey={s.key}
            stroke={s.color}
            strokeWidth={s.dashed ? 1.25 : 1.75}
            strokeDasharray={s.dashed ? '4 4' : undefined}
            dot={false}
            animationDuration={550}
            animationEasing="ease-out"
            isAnimationActive={display.animated}
          />
        ))}
      </LineChart>
    );
  }

  if (variant === 'bar') {
    return (
      <BarChart data={shaped.points} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
        {commonAxes}
        {visibleSeries.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            fill={s.color}
            fillOpacity={s.key === 'seriesA' ? 0.85 : s.key === 'seriesB' ? 0.7 : 0.55}
            radius={[2, 2, 0, 0]}
            isAnimationActive={display.animated}
          />
        ))}
      </BarChart>
    );
  }

  // area / stacked-area / flutter share an AreaChart with subtle
  // differences in stop opacity (flutter is more saturated to make
  // the shimmer/glow visible).
  const flutterBoost = isFlutter ? 1.4 : 1.0;
  return (
    <AreaChart data={shaped.points} margin={{ top: 6, right: 16, bottom: 0, left: 0 }}>
      {useAreaRenderer ? (
        <defs>
          {visibleSeries.map((s) => (
            <linearGradient
              key={`grad-${s.key}`}
              id={`rtc-${s.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor={s.color}
                stopOpacity={Math.min(0.5, 0.32 * flutterBoost)}
              />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
      ) : null}
      {commonAxes}
      {visibleSeries.map((s) => {
        // Lost is rendered as an overlay line even in area mode.
        if (s.asLineOverride && display.showLostLine) {
          return (
            <Line
              key={s.key}
              type={curve}
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={1.25}
              strokeDasharray="4 4"
              dot={false}
              animationDuration={750}
              animationEasing="ease-out"
              isAnimationActive={display.animated}
            />
          );
        }
        return (
          <Area
            key={s.key}
            type={curve}
            dataKey={s.key}
            stackId={isStacked ? 'rev' : undefined}
            stroke={s.color}
            strokeWidth={isFlutter ? 2 : 1.75}
            fill={`url(#rtc-${s.key})`}
            // Glow on the active dot — Flutter mode pumps this for
            // the "premium" look. Other variants keep dots off.
            activeDot={
              isFlutter
                ? {
                    r: 5,
                    stroke: s.color,
                    strokeWidth: 2,
                    fill: '#ffffff',
                    style: {
                      filter: `drop-shadow(0 0 6px ${s.color})`,
                    },
                  }
                : { r: 3 }
            }
            animationDuration={isFlutter ? 900 : 550}
            animationEasing="ease-out"
            isAnimationActive={display.animated}
          />
        );
      })}
    </AreaChart>
  );
}

/* ============================================================ */
/* Weekly body — pipeline bars (left axis) + outcomes (right)    */
/* ============================================================ */

/**
 * Two layers on two scales:
 *
 *   · New pipeline → weekly bars on the LEFT axis. Bars, not a line,
 *     because pipeline creation is discrete and lumpy — a line
 *     between two sparse weeks draws continuity that never existed.
 *   · Won / Lost   → thin lines on their own RIGHT axis, so a spike in
 *     pipeline creation can no longer flatten them against zero.
 *
 * Values past an axis cap are drawn at the cap and flagged: the bar
 * gets a notched top, the tooltip always reports the real number.
 */
function WeeklyBody({
  weekly,
  shaped,
  display,
  formatValue,
  formatAxis,
}: {
  weekly: WeeklyData;
  shaped: ShapedData;
  display: RevenueTrendConfig['display'];
  formatValue: (n: number) => string;
  formatAxis: (n: number) => string;
}) {
  const curve = display.smoothLines ? 'monotone' : 'linear';
  const seriesLabel = (key: ShapedSeries['key']) =>
    shaped.series.find((s) => s.key === key)?.label ?? key;

  return (
    <ComposedChart
      data={weekly.points}
      margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
    >
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
        minTickGap={20}
      />
      <YAxis
        yAxisId="pipeline"
        tick={{ fontSize: 10, fill: '#94a3b8' }}
        tickLine={false}
        axisLine={false}
        tickFormatter={(v) => formatAxis(Number(v))}
        width={56}
        domain={weekly.pipelineCap !== null ? [0, weekly.pipelineCap] : undefined}
        allowDataOverflow={weekly.pipelineCap !== null}
      />
      <YAxis
        yAxisId="outcome"
        orientation="right"
        tick={{ fontSize: 10, fill: '#94a3b8' }}
        tickLine={false}
        axisLine={false}
        tickFormatter={(v) => formatAxis(Number(v))}
        width={56}
        domain={weekly.outcomeCap !== null ? [0, weekly.outcomeCap] : undefined}
        allowDataOverflow={weekly.outcomeCap !== null}
      />
      <Tooltip
        cursor={{ fill: 'rgba(99,102,241,0.06)' }}
        content={(props) => {
          const { active, payload } = props as unknown as {
            active?: boolean;
            payload?: ReadonlyArray<{ payload?: WeeklyPoint }>;
          };
          if (!active || !payload || payload.length === 0) return null;
          const p = payload[0]?.payload;
          if (!p) return null;
          return (
            <WeeklyTooltip
              datum={p}
              showLost={display.showLostLine}
              formatValue={formatValue}
              labels={{
                newPipeline: seriesLabel('seriesB'),
                won: seriesLabel('seriesA'),
                lost: seriesLabel('seriesC'),
              }}
            />
          );
        }}
      />
      <Bar
        yAxisId="pipeline"
        dataKey="newPipelinePlot"
        fill="#6366f1"
        fillOpacity={0.75}
        shape={<CappedBar />}
        isAnimationActive={display.animated}
        animationDuration={550}
      />
      <Line
        yAxisId="outcome"
        type={curve}
        dataKey="wonPlot"
        stroke="#10b981"
        strokeWidth={2}
        dot={{ r: 2.5, strokeWidth: 0, fill: '#10b981' }}
        activeDot={{ r: 4 }}
        isAnimationActive={display.animated}
        animationDuration={650}
      />
      {display.showLostLine ? (
        <Line
          yAxisId="outcome"
          type={curve}
          dataKey="lostPlot"
          stroke="#f43f5e"
          strokeWidth={1.25}
          strokeDasharray="4 4"
          dot={false}
          activeDot={{ r: 3.5 }}
          isAnimationActive={display.animated}
          animationDuration={650}
        />
      ) : null}
    </ComposedChart>
  );
}

type BarShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
  fillOpacity?: number;
  payload?: WeeklyPoint;
};

/**
 * Bar renderer that makes truncation visible. A capped week draws at
 * the axis ceiling with a notched (zig-zag) top edge — the standard
 * "this value continues past the chart" convention — instead of
 * silently looking like a normal tall bar.
 */
function CappedBar(props: BarShapeProps) {
  const { x = 0, y = 0, width = 0, height = 0, fill, fillOpacity } = props;
  if (width <= 0 || height <= 0) return null;
  const capped = props.payload?.newPipelineCapped === true;
  const r = 2;

  if (!capped) {
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={r}
        ry={r}
        fill={fill}
        fillOpacity={fillOpacity}
      />
    );
  }

  // Zig-zag across the top edge.
  const teeth = 4;
  const step = width / teeth;
  const amp = Math.min(5, height);
  let d = `M ${x} ${y + height} L ${x} ${y + amp}`;
  for (let i = 0; i < teeth; i++) {
    d += ` L ${x + step * (i + 0.5)} ${y} L ${x + step * (i + 1)} ${y + amp}`;
  }
  d += ` L ${x + width} ${y + height} Z`;

  return (
    <g>
      <path d={d} fill={fill} fillOpacity={fillOpacity} />
      <path
        d={`M ${x} ${y + amp} ${Array.from(
          { length: teeth },
          (_, i) =>
            `L ${x + step * (i + 0.5)} ${y} L ${x + step * (i + 1)} ${y + amp}`,
        ).join(' ')}`}
        fill="none"
        stroke="#4338ca"
        strokeWidth={1}
      />
    </g>
  );
}

function WeeklyTooltip({
  datum,
  showLost,
  formatValue,
  labels,
}: {
  datum: WeeklyPoint;
  showLost: boolean;
  formatValue: (n: number) => string;
  labels: { newPipeline: string; won: string; lost: string };
}) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 text-[11px] text-slate-100 shadow-xl ring-1 ring-black/5 backdrop-blur-md"
    >
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-300">
        Week of {longDate(datum.weekStart)}
      </div>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
        <TooltipRow
          label={labels.newPipeline}
          value={formatValue(datum.newPipeline)}
          dotClassName="bg-indigo-500"
        />
        <TooltipRow
          label={labels.won}
          value={formatValue(datum.won)}
          dotClassName="bg-emerald-500"
        />
        {showLost ? (
          <TooltipRow
            label={labels.lost}
            value={formatValue(datum.lost)}
            dotClassName="bg-rose-500"
            dashed
          />
        ) : null}
      </dl>
      {datum.newPipelineCapped || datum.outcomeCapped ? (
        <p className="mt-1.5 max-w-56 border-t border-slate-700/60 pt-1 text-[10px] leading-snug text-amber-300">
          Values above are the real figures — this week runs past the
          chart axis, which is capped so the other weeks stay readable.
        </p>
      ) : null}
    </div>
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
  series,
  formatValue,
}: {
  datum: ShapedPoint;
  series: ShapedSeries[];
  formatValue: (n: number) => string;
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
        {series.map((s) => (
          <TooltipRow
            key={s.key}
            label={s.label}
            value={formatValue(datum[s.key])}
            dotClassName={s.dotClass}
            dashed={s.dashed}
          />
        ))}
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
