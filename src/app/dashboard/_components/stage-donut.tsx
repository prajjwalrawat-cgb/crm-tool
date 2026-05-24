'use client';

import { PieChart, Settings2 } from 'lucide-react';
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
  CHART_KEY_STAGE_DONUT,
  DEFAULT_STAGE_DONUT_CONFIG,
  STAGE_DONUT_METRICS,
  STAGE_DONUT_VARIANTS,
  type StageDonutConfig,
  type StageDonutVariant,
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
 * Stage Donut — pipeline breakdown as a donut (default), solid pie,
 * or mini stage bars. Editable via Studio: switch variant, switch
 * metric between deal count and revenue. Same hidden Cmd/Ctrl+K
 * activation pattern as the other charts.
 */

type Stage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';

const STAGE_ORDER: readonly Stage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
];

const STAGE_LABELS: Record<Stage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

const STAGE_FILL: Record<
  Stage,
  { light: string; dark: string; dot: string; bar: string }
> = {
  lead: { light: '#c7d2fe', dark: 'rgba(99,102,241,0.35)', dot: 'bg-indigo-200', bar: 'bg-indigo-200 dark:bg-indigo-400/35' },
  qualified: { light: '#a5b4fc', dark: 'rgba(99,102,241,0.55)', dot: 'bg-indigo-300', bar: 'bg-indigo-300 dark:bg-indigo-400/55' },
  proposal: { light: '#a78bfa', dark: 'rgba(139,92,246,0.65)', dot: 'bg-violet-400', bar: 'bg-violet-400 dark:bg-violet-400/65' },
  negotiation: { light: '#fcd34d', dark: 'rgba(245,158,11,0.7)', dot: 'bg-amber-400', bar: 'bg-amber-400 dark:bg-amber-400/70' },
  won: { light: '#6ee7b7', dark: 'rgba(16,185,129,0.8)', dot: 'bg-emerald-400', bar: 'bg-emerald-400 dark:bg-emerald-400/80' },
  lost: { light: '#fca5a5', dark: 'rgba(244,63,94,0.55)', dot: 'bg-rose-400', bar: 'bg-rose-400 dark:bg-rose-400/55' },
};

export function StageDonut({
  rows,
  currency,
  className,
  title: defaultTitle = 'Deal distribution',
  subtitle = 'How many deals sit in each stage',
  initialConfig,
  initialTitleOverride,
  persona,
}: {
  rows: PipelineByStageRow[];
  currency: TenantCurrencyContext;
  className?: string;
  title?: string;
  subtitle?: string;
  initialConfig?: StageDonutConfig | null;
  initialTitleOverride?: string | null;
  persona: Persona;
}) {
  const headingId = useId();
  const [config, setConfig] = useState<StageDonutConfig>(
    initialConfig ?? DEFAULT_STAGE_DONUT_CONFIG,
  );
  const [titleOverride, setTitleOverride] = useState<string | null>(
    initialTitleOverride ?? null,
  );
  const [studioOpen, setStudioOpen] = useState(false);
  const [chartFocused, setChartFocused] = useState(false);

  useStudioRegistration(studioOpen);

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

  const valueFor = (r: PipelineByStageRow) =>
    config.metric === 'revenue' ? r.totalAmountMinor : r.count;
  const formatValue = (n: number) =>
    config.metric === 'revenue' ? formatCurrency(n) : n.toLocaleString();
  const headerCountLabel = config.metric === 'revenue' ? 'Total revenue' : 'Total deals';

  const byStage = new Map<Stage, PipelineByStageRow>();
  for (const r of rows) {
    if ((STAGE_ORDER as readonly string[]).includes(r.stage)) {
      byStage.set(r.stage as Stage, r);
    }
  }
  const segments = STAGE_ORDER.map((stage) => {
    const r = byStage.get(stage);
    return {
      stage,
      v: r ? valueFor(r) : 0,
    };
  });
  const total = segments.reduce((s, x) => s + x.v, 0);

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
          'group/chart relative overflow-hidden rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_0_rgba(15,23,42,0.04)] outline-none transition-all duration-200 focus-within:-translate-y-0.5 focus-within:shadow-[0_18px_38px_-18px_rgba(99,102,241,0.45),0_0_0_1px_rgba(99,102,241,0.18)] focus-within:ring-1 focus-within:ring-indigo-400/30 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
          className,
        )}
      >
        <header className="mb-4 flex items-baseline justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <PieChart className="h-3 w-3" aria-hidden />
              {config.metric === 'revenue' ? 'Revenue · stages' : 'Counts'}
            </div>
            <h2
              id={headingId}
              className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]"
            >
              {title}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              {subtitle}
            </p>
          </div>
          <div className="flex items-start gap-2 text-right">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                {headerCountLabel}
              </div>
              <div className="font-mono text-xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                {formatValue(total)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStudioOpen(true)}
              aria-label="Open Chart Studio (Cmd/Ctrl+E)"
              title="Chart Studio · ⌘E"
              className="rounded-md border border-transparent p-1 text-slate-400 opacity-0 transition hover:border-slate-200 hover:bg-slate-50 hover:text-slate-700 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 group-hover/chart:opacity-100 group-focus-within/chart:opacity-100 dark:hover:border-[#1F1F1F] dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </header>

        {total === 0 ? (
          <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
            No data yet — once deals enter the pipeline, the breakdown will appear.
          </p>
        ) : config.variant === 'bars' ? (
          <MiniBarsBody
            segments={segments}
            formatValue={formatValue}
            total={total}
            animated={config.display.animated}
          />
        ) : (
          <RingBody
            segments={segments}
            total={total}
            isDonut={config.variant === 'donut'}
            formatValue={formatValue}
            showLegend={config.display.showLegend}
            animated={config.display.animated}
          />
        )}
      </section>

      <StageDonutStudio
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
/* Ring body (donut + pie share this; pie is donut with r=0)     */
/* ============================================================ */

function RingBody({
  segments,
  total,
  isDonut,
  formatValue,
  showLegend,
  animated,
}: {
  segments: Array<{ stage: Stage; v: number }>;
  total: number;
  isDonut: boolean;
  formatValue: (n: number) => string;
  showLegend: boolean;
  animated: boolean;
}) {
  const cx = 50;
  const cy = 50;
  const rOuter = 44;
  const rInner = isDonut ? 28 : 0;

  let cumulative = 0;
  const slices = segments.map((seg) => {
    if (seg.v === 0 || total === 0) return null;
    const fraction = seg.v / total;
    const startAngle = cumulative * Math.PI * 2 - Math.PI / 2;
    cumulative += fraction;
    const endAngle = cumulative * Math.PI * 2 - Math.PI / 2;
    const isFull = fraction >= 0.999;
    const d = isFull
      ? buildFullDonutPath(cx, cy, rOuter, rInner)
      : buildArcPath(cx, cy, rOuter, rInner, startAngle, endAngle);
    return {
      stage: seg.stage,
      v: seg.v,
      pct: Math.round(fraction * 100),
      d,
    };
  });

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative h-40 w-40 flex-shrink-0">
        <svg
          viewBox="0 0 100 100"
          className={cn('h-full w-full', animated && 'rtc-donut-fade')}
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
          {slices.map((p) =>
            p ? (
              <g key={p.stage}>
                <path
                  d={p.d}
                  fill={STAGE_FILL[p.stage].light}
                  fillRule="evenodd"
                  className="dark:hidden"
                >
                  <title>{`${STAGE_LABELS[p.stage]}: ${formatValue(p.v)} (${p.pct}%)`}</title>
                </path>
                <path
                  d={p.d}
                  fill={STAGE_FILL[p.stage].dark}
                  fillRule="evenodd"
                  className="hidden dark:block"
                >
                  <title>{`${STAGE_LABELS[p.stage]}: ${formatValue(p.v)} (${p.pct}%)`}</title>
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
      {showLegend ? (
        <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
          {slices.map((p) =>
            p ? (
              <li
                key={p.stage}
                className="flex items-center justify-between gap-2 text-[12px]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 flex-shrink-0 rounded-full',
                      STAGE_FILL[p.stage].dot,
                    )}
                    aria-hidden
                  />
                  <span className="truncate text-slate-700 dark:text-[#FAFAFA]">
                    {STAGE_LABELS[p.stage]}
                  </span>
                </span>
                <span className="flex flex-shrink-0 items-baseline gap-2 font-mono tabular-nums">
                  <span className="font-semibold text-slate-900 dark:text-[#FAFAFA]">
                    {formatValue(p.v)}
                  </span>
                  <span className="text-[10px] text-slate-500 dark:text-[#A1A1AA]">
                    {p.pct}%
                  </span>
                </span>
              </li>
            ) : null,
          )}
        </ul>
      ) : null}
      <style>{`
        @keyframes rtc-donut-fade {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        .rtc-donut-fade { animation: rtc-donut-fade 360ms ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .rtc-donut-fade { animation: none; }
        }
      `}</style>
    </div>
  );
}

/* ============================================================ */
/* Mini-bars body                                                */
/* ============================================================ */

function MiniBarsBody({
  segments,
  formatValue,
  total,
  animated,
}: {
  segments: Array<{ stage: Stage; v: number }>;
  formatValue: (n: number) => string;
  total: number;
  animated: boolean;
}) {
  const max = Math.max(...segments.map((s) => s.v), 1);
  return (
    <div className="flex items-end gap-2.5">
      {segments.map((s) => {
        const heightPct = (s.v / max) * 100;
        const renderedHeight = Math.max(4, heightPct);
        const pct = total > 0 ? Math.round((s.v / total) * 100) : 0;
        return (
          <div key={s.stage} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <div
              title={`${STAGE_LABELS[s.stage]}: ${formatValue(s.v)} (${pct}%)`}
              className={cn(
                'w-full rounded-md transition-all duration-500 ease-out',
                STAGE_FILL[s.stage].bar,
                animated && 'origin-bottom',
              )}
              style={{ height: `${(renderedHeight / 100) * 110}px` }}
              aria-hidden
            />
            <span className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              {STAGE_LABELS[s.stage]}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-slate-700 dark:text-[#FAFAFA]">
              {formatValue(s.v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================ */
/* Studio panel                                                  */
/* ============================================================ */

function StageDonutStudio({
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
  config: StageDonutConfig;
  onConfigChange: Dispatch<SetStateAction<StageDonutConfig>>;
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

  function update<K extends keyof StageDonutConfig['display']>(
    key: K,
    value: StageDonutConfig['display'][K],
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
        chartKey: CHART_KEY_STAGE_DONUT,
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
        chartKey: CHART_KEY_STAGE_DONUT,
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      onConfigChange(DEFAULT_STAGE_DONUT_CONFIG);
      onTitleChange(null);
      setSavedJustNow(false);
    });
  }

  return (
    <StudioShell
      open={open}
      onClose={onClose}
      title={titleOverride?.trim() || chartTitle}
      subtitle="Switch between donut, pie, or mini bars."
      saving={saving}
      resetting={resetting}
      saveError={saveError}
      savedJustNow={savedJustNow}
      onSave={handleSave}
      onReset={handleReset}
    >
      <StudioSection label="Chart type">
        <div className="grid grid-cols-3 gap-2">
          {STAGE_DONUT_VARIANTS.map((v) => (
            <button
              key={v.value}
              type="button"
              onClick={() =>
                onConfigChange((prev) => ({ ...prev, variant: v.value as StageDonutVariant }))
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
          {STAGE_DONUT_METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() =>
                onConfigChange((prev) => ({ ...prev, metric: m.value }))
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
          label="Show legend"
          hint="Stage list with percentages"
          checked={config.display.showLegend}
          onChange={(v) => update('showLegend', v)}
        />
        <StudioToggleRow
          label="Animations"
          hint="Fade-in on first render"
          checked={config.display.animated}
          onChange={(v) => update('animated', v)}
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

/* ============================================================ */

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
