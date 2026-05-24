'use client';

import { ArrowDown, Settings2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  CHART_KEY_STAGE_CONVERSION,
  DEFAULT_STAGE_CONVERSION_CONFIG,
  STAGE_CONVERSION_METRICS,
  STAGE_CONVERSION_VARIANTS,
  type StageConversionConfig,
  type StageConversionMetric,
  type StageConversionVariant,
} from '@/lib/chart-studio/config';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { Persona } from '@/lib/personas';
import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

import {
  resetChartViewAction,
  saveChartViewAction,
} from './chart-studio/actions';
import {
  StudioSection,
  StudioShell,
  StudioToggleRow,
} from './chart-studio/studio-shell';
import { useStudioRegistration } from './edit-mode/edit-mode-context';

/**
 * Stage Conversion chart — pipeline-by-stage breakdown rendered as
 * compact horizontal bars (default) or a true trapezoid funnel,
 * donut, or pie. Power users open Studio (Cmd/Ctrl+K when focused
 * or click the gear icon on hover) to switch variant or metric.
 *
 * Metrics:
 *   revenue   → stage revenue (currency)
 *   dealCount → number of deals in each stage
 *
 * Variants:
 *   bars      → horizontal rows (default; revenue/count + conversion %)
 *   funnel    → trapezoid SVG with tapered segments — the "real funnel"
 *   donut     → centred ring of stage share
 *   pie       → solid pie chart
 */

type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won';
const FORWARD_STAGES: readonly Stage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
];
const LABELS: Record<Stage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
};
const PROB: Record<Stage, number> = {
  lead: 0.1,
  qualified: 0.25,
  proposal: 0.5,
  negotiation: 0.75,
  won: 1.0,
};
const STAGE_TINT: Record<
  Stage,
  { barLight: string; barDark: string; svgLight: string; svgDark: string; dotClass: string }
> = {
  lead: {
    barLight: 'bg-indigo-200',
    barDark: 'dark:bg-indigo-400/30',
    svgLight: '#c7d2fe',
    svgDark: 'rgba(99,102,241,0.35)',
    dotClass: 'bg-indigo-200',
  },
  qualified: {
    barLight: 'bg-indigo-300',
    barDark: 'dark:bg-indigo-400/45',
    svgLight: '#a5b4fc',
    svgDark: 'rgba(99,102,241,0.55)',
    dotClass: 'bg-indigo-300',
  },
  proposal: {
    barLight: 'bg-violet-400',
    barDark: 'dark:bg-violet-400/55',
    svgLight: '#a78bfa',
    svgDark: 'rgba(139,92,246,0.65)',
    dotClass: 'bg-violet-400',
  },
  negotiation: {
    barLight: 'bg-amber-400',
    barDark: 'dark:bg-amber-400/60',
    svgLight: '#fcd34d',
    svgDark: 'rgba(245,158,11,0.7)',
    dotClass: 'bg-amber-400',
  },
  won: {
    barLight: 'bg-emerald-500',
    barDark: 'dark:bg-emerald-400/70',
    svgLight: '#6ee7b7',
    svgDark: 'rgba(16,185,129,0.8)',
    dotClass: 'bg-emerald-500',
  },
};

export function StageConversionBars({
  rows,
  currency,
  className,
  title: defaultTitle = 'Pipeline by stage',
  subtitle = 'Revenue-weighted bars · stage-to-stage conversion',
  initialConfig,
  initialTitleOverride,
  persona,
}: {
  rows: PipelineByStageRow[];
  currency: TenantCurrencyContext;
  className?: string;
  title?: string;
  subtitle?: string;
  initialConfig?: StageConversionConfig | null;
  initialTitleOverride?: string | null;
  persona: Persona;
}) {
  const headingId = useId();
  const [config, setConfig] = useState<StageConversionConfig>(
    initialConfig ?? DEFAULT_STAGE_CONVERSION_CONFIG,
  );
  const [titleOverride, setTitleOverride] = useState<string | null>(
    initialTitleOverride ?? null,
  );
  const [studioOpen, setStudioOpen] = useState(false);
  const [chartFocused, setChartFocused] = useState(false);

  useStudioRegistration(studioOpen);

  // Focus-gated Cmd/Ctrl+E — same pattern as the other editable charts.
  // ⌘K is reserved for the dashboard's global command palette.
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

  const formatCurrency = useCallback(
    (amountMinor: number) =>
      currency.compactNumbers
        ? formatCompactTenantCurrency(amountMinor, currency)
        : formatTenantCurrency(amountMinor, currency),
    [currency],
  );

  // Build ordered, normalized rows per the selected metric. Each stage
  // exposes `value` for plotting and `displayValue` for formatting.
  const byStage = new Map<Stage, PipelineByStageRow>();
  for (const r of rows) {
    if ((FORWARD_STAGES as readonly string[]).includes(r.stage)) {
      byStage.set(r.stage as Stage, r);
    }
  }
  const ordered = FORWARD_STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        stageLabel: LABELS[s],
        count: 0,
        totalAmountMinor: 0,
      },
  );

  const valueFor = (r: (typeof ordered)[number]) =>
    config.metric === 'revenue' ? r.totalAmountMinor : r.count;
  const formatValue = (n: number) =>
    config.metric === 'revenue' ? formatCurrency(n) : n.toLocaleString();

  const title = (titleOverride?.trim() || defaultTitle).trim();

  return (
    <>
      <section
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
          'group/chart relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] outline-none transition-all duration-200 focus-within:-translate-y-0.5 focus-within:shadow-[0_18px_38px_-18px_rgba(99,102,241,0.45),0_0_0_1px_rgba(99,102,241,0.18)] focus-within:ring-1 focus-within:ring-indigo-400/30 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
          className,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <ArrowDown className="h-3 w-3" aria-hidden />
              {config.metric === 'revenue' ? 'Conversion · revenue' : 'Conversion · deals'}
            </div>
            <h2
              id={headingId}
              className="mt-2 truncate text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]"
            >
              {title}
            </h2>
            {!config.display.compact ? (
              <p className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setStudioOpen(true)}
            aria-label="Open Chart Studio (Cmd/Ctrl+E)"
            title="Chart Studio · ⌘E"
            className="self-start rounded-md border border-transparent p-1 text-slate-400 opacity-0 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 group-hover/chart:opacity-100 group-focus-within/chart:opacity-100 dark:hover:border-[#1F1F1F] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        {config.variant === 'bars' ? (
          <BarsBody
            ordered={ordered}
            valueFor={valueFor}
            formatValue={formatValue}
            config={config}
          />
        ) : config.variant === 'funnel' ? (
          <FunnelBody
            ordered={ordered}
            valueFor={valueFor}
            formatValue={formatValue}
            config={config}
          />
        ) : (
          <PieBody
            variant={config.variant}
            ordered={ordered}
            valueFor={valueFor}
            formatValue={formatValue}
            animated={config.display.animated}
          />
        )}
      </section>

      <StageConversionStudio
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
/* Bars body                                                     */
/* ============================================================ */

function BarsBody({
  ordered,
  valueFor,
  formatValue,
  config,
}: {
  ordered: PipelineByStageRow[];
  valueFor: (r: PipelineByStageRow) => number;
  formatValue: (n: number) => string;
  config: StageConversionConfig;
}) {
  const maxValue = Math.max(...ordered.map((r) => valueFor(r)), 1);
  return (
    <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
      {ordered.map((row, i) => {
        const stage = row.stage as Stage;
        const v = valueFor(row);
        const widthPct = (v / maxValue) * 100;
        const renderedWidth = Math.max(2, widthPct);
        const prev = i > 0 ? ordered[i - 1]! : null;
        const prevV = prev ? valueFor(prev) : 0;
        const conversionPct =
          prev && prevV > 0 ? Math.round((v / prevV) * 100) : null;
        const conversionTone =
          conversionPct === null
            ? 'neutral'
            : conversionPct >= 60
              ? 'good'
              : conversionPct >= 30
                ? 'warn'
                : 'bad';
        const conversionClass = {
          good: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15',
          warn: 'text-amber-800 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15',
          bad: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15',
          neutral: 'text-slate-500 bg-slate-50 dark:text-[#A1A1AA] dark:bg-[#181818]',
        }[conversionTone];
        return (
          <li key={stage} className="flex items-center gap-3 px-5 py-2.5 text-[12px]">
            <span className="w-24 flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-slate-600 dark:text-[#A1A1AA]">
              {LABELS[stage]}
            </span>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-[#181818]">
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out',
                  STAGE_TINT[stage].barLight,
                  STAGE_TINT[stage].barDark,
                )}
                style={{ width: `${renderedWidth}%` }}
                aria-hidden
              />
            </div>
            <div className="flex-shrink-0 text-right">
              <div className="font-mono text-[12.5px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                {formatValue(v)}
              </div>
              <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] text-slate-500 dark:text-[#A1A1AA]">
                {config.metric === 'revenue' ? (
                  <>
                    <span>
                      {row.count} {row.count === 1 ? 'deal' : 'deals'}
                    </span>
                    {config.display.showCloseProb ? (
                      <>
                        <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
                        <span>{Math.round(PROB[stage] * 100)}% close</span>
                      </>
                    ) : null}
                  </>
                ) : config.display.showCloseProb ? (
                  <span>{Math.round(PROB[stage] * 100)}% close</span>
                ) : null}
              </div>
            </div>
            <div className="w-20 flex-shrink-0 text-right">
              {config.display.showConversionPct && conversionPct !== null ? (
                <span
                  className={cn(
                    'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums',
                    conversionClass,
                  )}
                >
                  {conversionPct}%
                </span>
              ) : (
                <span className="text-[10px] text-slate-300 dark:text-[#3F3F46]">—</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ============================================================ */
/* Funnel body — real trapezoid renderer                         */
/* ============================================================ */

function FunnelBody({
  ordered,
  valueFor,
  formatValue,
  config,
}: {
  ordered: PipelineByStageRow[];
  valueFor: (r: PipelineByStageRow) => number;
  formatValue: (n: number) => string;
  config: StageConversionConfig;
}) {
  const maxValue = Math.max(...ordered.map((r) => valueFor(r)), 1);
  const widthOf = (v: number) => Math.max(0.1, v / maxValue);
  const widths = ordered.map((r) => widthOf(valueFor(r)));

  const VB_W = 100;
  const VB_H = 100;
  const BAND_H = VB_H / ordered.length;

  return (
    <div className="px-5 py-4">
      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className={cn(
            'h-64 w-full sm:h-72',
            config.display.animated && 'rtc-funnel-fade',
          )}
          preserveAspectRatio="none"
          aria-hidden
        >
          {ordered.map((row, i) => {
            const stage = row.stage as Stage;
            const top = i * BAND_H;
            const bottom = (i + 1) * BAND_H;
            const wTop = widths[i]! * VB_W;
            const wBot = (widths[i + 1] ?? widths[i]!) * VB_W;
            const cx = VB_W / 2;
            const points = [
              `${cx - wTop / 2},${top}`,
              `${cx + wTop / 2},${top}`,
              `${cx + wBot / 2},${bottom}`,
              `${cx - wBot / 2},${bottom}`,
            ].join(' ');
            return (
              <g key={stage}>
                <polygon
                  points={points}
                  fill={STAGE_TINT[stage].svgLight}
                  className="transition-opacity duration-200 hover:opacity-95 dark:hidden"
                >
                  <title>
                    {`${LABELS[stage]}: ${formatValue(valueFor(row))} · ${row.count} ${row.count === 1 ? 'deal' : 'deals'}`}
                  </title>
                </polygon>
                <polygon
                  points={points}
                  fill={STAGE_TINT[stage].svgDark}
                  className="hidden transition-opacity duration-200 hover:opacity-95 dark:block"
                >
                  <title>
                    {`${LABELS[stage]}: ${formatValue(valueFor(row))} · ${row.count} ${row.count === 1 ? 'deal' : 'deals'}`}
                  </title>
                </polygon>
              </g>
            );
          })}
        </svg>

        {/* Stage labels overlay — centered inside each band */}
        <div className="pointer-events-none absolute inset-0">
          <ul
            className="relative grid h-full"
            style={{ gridTemplateRows: `repeat(${ordered.length}, minmax(0, 1fr))` }}
          >
            {ordered.map((row, i) => {
              const stage = row.stage as Stage;
              const prev = i > 0 ? ordered[i - 1]! : null;
              const prevV = prev ? valueFor(prev) : 0;
              const v = valueFor(row);
              const conversionPct =
                prev && prevV > 0 ? Math.round((v / prevV) * 100) : null;
              return (
                <li key={stage} className="flex items-center justify-center">
                  <div className="flex flex-col items-center text-center">
                    <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-700 dark:text-[#FAFAFA]">
                      {LABELS[stage]}
                    </span>
                    <div className="mt-0.5 flex items-baseline gap-1.5">
                      <span className="font-mono text-[12px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                        {formatValue(v)}
                      </span>
                      {config.display.showConversionPct && conversionPct !== null ? (
                        <span
                          className={cn(
                            'rounded px-1 py-px font-mono text-[9.5px] font-semibold tabular-nums backdrop-blur-sm',
                            conversionPct >= 60
                              ? 'bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100'
                              : conversionPct >= 30
                                ? 'bg-white/70 text-slate-700 dark:bg-white/10 dark:text-slate-200'
                                : 'bg-rose-100/80 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100',
                          )}
                        >
                          {conversionPct}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <style>{`
        @keyframes rtc-funnel-band-in {
          from { opacity: 0; transform: translateY(2px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .rtc-funnel-fade polygon {
          animation: rtc-funnel-band-in 320ms ease-out both;
        }
        .rtc-funnel-fade polygon:nth-of-type(1) { animation-delay: 0ms; }
        .rtc-funnel-fade polygon:nth-of-type(2) { animation-delay: 60ms; }
        .rtc-funnel-fade polygon:nth-of-type(3) { animation-delay: 120ms; }
        .rtc-funnel-fade polygon:nth-of-type(4) { animation-delay: 180ms; }
        .rtc-funnel-fade polygon:nth-of-type(5) { animation-delay: 240ms; }
        @media (prefers-reduced-motion: reduce) {
          .rtc-funnel-fade polygon { animation: none; }
        }
      `}</style>
    </div>
  );
}

/* ============================================================ */
/* Pie / Donut body                                              */
/* ============================================================ */

function PieBody({
  variant,
  ordered,
  valueFor,
  formatValue,
  animated,
}: {
  variant: StageConversionVariant;
  ordered: PipelineByStageRow[];
  valueFor: (r: PipelineByStageRow) => number;
  formatValue: (n: number) => string;
  animated: boolean;
}) {
  const total = ordered.reduce((s, r) => s + valueFor(r), 0);
  const isDonut = variant === 'donut';
  const cx = 50;
  const cy = 50;
  const rOuter = 44;
  const rInner = isDonut ? 28 : 0;

  let cumulative = 0;
  const slices = ordered.map((row) => {
    const v = valueFor(row);
    if (v === 0 || total === 0) return null;
    const fraction = v / total;
    const startAngle = cumulative * Math.PI * 2 - Math.PI / 2;
    cumulative += fraction;
    const endAngle = cumulative * Math.PI * 2 - Math.PI / 2;
    const isFull = fraction >= 0.999;
    const d = isFull
      ? buildFullDonutPath(cx, cy, rOuter, rInner)
      : buildArcPath(cx, cy, rOuter, rInner, startAngle, endAngle);
    return {
      stage: row.stage as Stage,
      v,
      pct: Math.round(fraction * 100),
      d,
    };
  });

  return (
    <div className="px-5 py-4">
      {total === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No data yet — once deals enter the pipeline, the breakdown will appear.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-5">
          <div className="relative h-44 w-44 flex-shrink-0">
            <svg
              viewBox="0 0 100 100"
              className={cn('h-full w-full', animated && 'rtc-pie-fade')}
              aria-hidden
            >
              {isDonut ? (
                <>
                  <path
                    d={buildFullDonutPath(cx, cy, rOuter, rInner)}
                    fill="rgb(241 245 249)"
                    fillRule="evenodd"
                    className="dark:hidden"
                  />
                  <path
                    d={buildFullDonutPath(cx, cy, rOuter, rInner)}
                    fill="rgba(255,255,255,0.04)"
                    fillRule="evenodd"
                    className="hidden dark:block"
                  />
                </>
              ) : null}
              {slices.map((s) =>
                s ? (
                  <g key={s.stage}>
                    <path
                      d={s.d}
                      fill={STAGE_TINT[s.stage].svgLight}
                      fillRule="evenodd"
                      className="dark:hidden"
                    >
                      <title>{`${LABELS[s.stage]}: ${formatValue(s.v)} (${s.pct}%)`}</title>
                    </path>
                    <path
                      d={s.d}
                      fill={STAGE_TINT[s.stage].svgDark}
                      fillRule="evenodd"
                      className="hidden dark:block"
                    >
                      <title>{`${LABELS[s.stage]}: ${formatValue(s.v)} (${s.pct}%)`}</title>
                    </path>
                  </g>
                ) : null,
              )}
            </svg>
            {isDonut ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                  {formatValue(total)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                  total
                </span>
              </div>
            ) : null}
          </div>
          <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
            {slices.map((s) =>
              s ? (
                <li
                  key={s.stage}
                  className="flex items-center justify-between gap-2 text-[12px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 flex-shrink-0 rounded-full',
                        STAGE_TINT[s.stage].dotClass,
                      )}
                      aria-hidden
                    />
                    <span className="truncate text-slate-700 dark:text-[#FAFAFA]">
                      {LABELS[s.stage]}
                    </span>
                  </span>
                  <span className="flex flex-shrink-0 items-baseline gap-2 font-mono tabular-nums">
                    <span className="font-semibold text-slate-900 dark:text-[#FAFAFA]">
                      {formatValue(s.v)}
                    </span>
                    <span className="text-[10px] text-slate-500 dark:text-[#A1A1AA]">
                      {s.pct}%
                    </span>
                  </span>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
      <style>{`
        @keyframes rtc-pie-fade {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        .rtc-pie-fade { animation: rtc-pie-fade 360ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .rtc-pie-fade { animation: none; }
        }
      `}</style>
    </div>
  );
}

function polar(cx: number, cy: number, r: number, a: number) {
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function buildArcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, rOuter, startAngle);
  const o1 = polar(cx, cy, rOuter, endAngle);
  if (rInner === 0) {
    return [
      `M ${cx} ${cy}`,
      `L ${o0.x} ${o0.y}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o1.x} ${o1.y}`,
      'Z',
    ].join(' ');
  }
  const i1 = polar(cx, cy, rInner, endAngle);
  const i0 = polar(cx, cy, rInner, startAngle);
  return [
    `M ${o0.x} ${o0.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o1.x} ${o1.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${i0.x} ${i0.y}`,
    'Z',
  ].join(' ');
}

function buildFullDonutPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
): string {
  return [
    `M ${cx - rOuter} ${cy}`,
    `A ${rOuter} ${rOuter} 0 1 0 ${cx + rOuter} ${cy}`,
    `A ${rOuter} ${rOuter} 0 1 0 ${cx - rOuter} ${cy}`,
    'Z',
    `M ${cx - rInner} ${cy}`,
    `A ${rInner} ${rInner} 0 1 1 ${cx + rInner} ${cy}`,
    `A ${rInner} ${rInner} 0 1 1 ${cx - rInner} ${cy}`,
    'Z',
  ].join(' ');
}

/* ============================================================ */
/* Studio panel                                                  */
/* ============================================================ */

function StageConversionStudio({
  chartTitle,
  open,
  onClose,
  config,
  onConfigChange,
  titleOverride,
  onTitleChange,
  persona,
}: {
  chartTitle: string;
  open: boolean;
  onClose: () => void;
  config: StageConversionConfig;
  onConfigChange: Dispatch<SetStateAction<StageConversionConfig>>;
  titleOverride: string | null;
  onTitleChange: Dispatch<SetStateAction<string | null>>;
  persona: Persona;
}) {
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [saving, startSaveTransition] = useTransition();
  const [resetting, startResetTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setSavedJustNow(false);
    const timer = setTimeout(() => titleInputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [open]);

  function update<K extends keyof StageConversionConfig['display']>(
    key: K,
    value: StageConversionConfig['display'][K],
  ) {
    onConfigChange((prev) => ({
      ...prev,
      display: { ...prev.display, [key]: value },
    }));
  }

  function handleSave() {
    setSaveError(null);
    setSavedJustNow(false);
    startSaveTransition(async () => {
      const result = await saveChartViewAction({
        chartKey: CHART_KEY_STAGE_CONVERSION,
        config: {
          variant: config.variant,
          metric: config.metric,
          display: config.display,
        },
        title: titleOverride?.trim() ? titleOverride.trim() : null,
        roleScope: 'user',
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      setSavedJustNow(true);
      setTimeout(() => setSavedJustNow(false), 2000);
    });
  }

  function handleReset() {
    startResetTransition(async () => {
      const result = await resetChartViewAction({
        chartKey: CHART_KEY_STAGE_CONVERSION,
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      onConfigChange(DEFAULT_STAGE_CONVERSION_CONFIG);
      onTitleChange(null);
      setSavedJustNow(false);
    });
  }

  return (
    <StudioShell
      open={open}
      onClose={onClose}
      title={titleOverride?.trim() || chartTitle}
      subtitle="Switch between bars, funnel, donut, or pie."
      saving={saving}
      resetting={resetting}
      saveError={saveError}
      savedJustNow={savedJustNow}
      onSave={handleSave}
      onReset={handleReset}
    >
      <StudioSection label="Chart type">
        <div className="grid grid-cols-2 gap-2">
          {STAGE_CONVERSION_VARIANTS.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() =>
                onConfigChange((prev) => ({ ...prev, variant: v.value }))
              }
              aria-pressed={config.variant === v.value}
              className={cn(
                'flex h-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition',
                config.variant === v.value
                  ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-300 dark:border-indigo-500/50 dark:bg-indigo-500/10'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:hover:border-[#2A2A2A] dark:hover:bg-[#111111]',
              )}
            >
              <span
                className={cn(
                  'text-[12px] font-semibold',
                  config.variant === v.value
                    ? 'text-indigo-800 dark:text-indigo-100'
                    : 'text-slate-900 dark:text-[#FAFAFA]',
                )}
              >
                {v.label}
              </span>
              <span className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                {v.description}
              </span>
            </button>
          ))}
        </div>
      </StudioSection>

      <StudioSection label="Metric">
        <div className="grid grid-cols-1 gap-2">
          {STAGE_CONVERSION_METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() =>
                onConfigChange((prev) => ({ ...prev, metric: m.value as StageConversionMetric }))
              }
              aria-pressed={config.metric === m.value}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition',
                config.metric === m.value
                  ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-300 dark:border-indigo-500/50 dark:bg-indigo-500/10'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:hover:border-[#2A2A2A] dark:hover:bg-[#111111]',
              )}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    'text-[12.5px] font-semibold',
                    config.metric === m.value
                      ? 'text-indigo-800 dark:text-indigo-100'
                      : 'text-slate-900 dark:text-[#FAFAFA]',
                  )}
                >
                  {m.label}
                </div>
                <div className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                  {m.description}
                </div>
              </div>
            </button>
          ))}
        </div>
      </StudioSection>

      <StudioSection label="Appearance">
        <StudioToggleRow
          label="Conversion %"
          hint="Show stage-to-stage retention chips"
          checked={config.display.showConversionPct}
          onChange={(v) => update('showConversionPct', v)}
        />
        <StudioToggleRow
          label="Close probability"
          hint="Heuristic close-prob meta per stage"
          checked={config.display.showCloseProb}
          onChange={(v) => update('showCloseProb', v)}
        />
        <StudioToggleRow
          label="Animations"
          hint="Subtle enter animations on render"
          checked={config.display.animated}
          onChange={(v) => update('animated', v)}
        />
        <StudioToggleRow
          label="Compact header"
          hint="Hide the subtitle line"
          checked={config.display.compact}
          onChange={(v) => update('compact', v)}
        />
      </StudioSection>

      <StudioSection label="Title">
        <input
          ref={titleInputRef}
          type="text"
          value={titleOverride ?? ''}
          onChange={(e) => onTitleChange(e.target.value || null)}
          placeholder={chartTitle}
          maxLength={80}
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] shadow-sm transition placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/20 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:placeholder:text-[#71717A]"
        />
      </StudioSection>

      <StudioSection label="Scope">
        <p className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-[11.5px] text-slate-600 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          {persona === 'admin'
            ? 'Saving as a personal view. Org-wide views in a follow-up phase.'
            : persona === 'manager'
              ? 'Saving as a personal view. Team-shared views in a follow-up phase.'
              : 'Saving as a personal view — visible only to you.'}
        </p>
      </StudioSection>
    </StudioShell>
  );
}
