'use client';

import {
  AreaChart as AreaIcon,
  BarChart3,
  Check,
  Hash,
  Layers,
  LineChart as LineIcon,
  Percent,
  Sparkles,
  Type as TypeIcon,
  Waves,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type SetStateAction,
} from 'react';

import {
  CHART_KEY_REVENUE_TREND,
  DEFAULT_REVENUE_TREND_CONFIG,
  REVENUE_TREND_METRICS,
  REVENUE_TREND_VARIANTS,
  type RevenueTrendConfig,
  type RevenueTrendMetric,
  type RevenueTrendVariant,
} from '@/lib/chart-studio/config';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

import { resetChartViewAction, saveChartViewAction } from './actions';
import { StudioSection, StudioShell, StudioToggleRow } from './studio-shell';

/**
 * Revenue Trend Chart Studio panel. Uses the shared `StudioShell`
 * for chrome (slide-in, blur backdrop, header, footer, save/reset).
 * The form inside is revenue-trend specific: chart-type tiles,
 * metric rows, appearance toggles, title rename, scope hint.
 */
export function ChartStudioPanel({
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
  config: RevenueTrendConfig;
  onConfigChange: Dispatch<SetStateAction<RevenueTrendConfig>>;
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

  function update<K extends keyof RevenueTrendConfig['display']>(
    key: K,
    value: RevenueTrendConfig['display'][K],
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
        chartKey: CHART_KEY_REVENUE_TREND,
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
        chartKey: CHART_KEY_REVENUE_TREND,
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      onConfigChange(DEFAULT_REVENUE_TREND_CONFIG);
      onTitleChange(null);
      setSavedJustNow(false);
    });
  }

  return (
    <StudioShell
      open={open}
      onClose={onClose}
      title={titleOverride?.trim() || chartTitle}
      subtitle="Personalize how this chart looks. Saves to your account only."
      saving={saving}
      resetting={resetting}
      saveError={saveError}
      savedJustNow={savedJustNow}
      onSave={handleSave}
      onReset={handleReset}
    >
      {/* Chart type */}
      <StudioSection label="Chart type">
        <div className="grid grid-cols-2 gap-2">
          {REVENUE_TREND_VARIANTS.map((v) => (
            <VariantTile
              key={v.value}
              selected={config.variant === v.value}
              variant={v.value}
              label={v.label}
              description={v.description}
              onSelect={() =>
                onConfigChange((prev) => ({ ...prev, variant: v.value }))
              }
            />
          ))}
        </div>
      </StudioSection>

      {/* Metric */}
      <StudioSection label="Metric">
        <div className="grid grid-cols-1 gap-2">
          {REVENUE_TREND_METRICS.map((m) => (
            <MetricRow
              key={m.value}
              selected={config.metric === m.value}
              metric={m.value}
              label={m.label}
              description={m.description}
              onSelect={() =>
                onConfigChange((prev) => ({ ...prev, metric: m.value }))
              }
            />
          ))}
        </div>
        <p className="mt-2 text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
          Switching the metric instantly reshapes the chart series.
          Dimension + filter selectors are coming in a follow-up phase.
        </p>
      </StudioSection>

      {/* Appearance */}
      <StudioSection label="Appearance">
        <StudioToggleRow
          label="Smooth lines"
          hint="Monotone curves vs. straight segments"
          checked={config.display.smoothLines}
          onChange={(v) => update('smoothLines', v)}
        />
        <StudioToggleRow
          label="Animations"
          hint="Subtle enter animations on render"
          checked={config.display.animated}
          onChange={(v) => update('animated', v)}
        />
        <StudioToggleRow
          label="Show legend"
          hint="Footer color-coded series strip"
          checked={config.display.showLegend}
          onChange={(v) => update('showLegend', v)}
        />
        <StudioToggleRow
          label="Lost / negative series"
          hint="Dashed rose-tone context overlay"
          checked={config.display.showLostLine}
          onChange={(v) => update('showLostLine', v)}
        />
        <StudioToggleRow
          label="Cumulative view"
          hint="Running totals over the window"
          checked={config.display.cumulative}
          onChange={(v) => update('cumulative', v)}
        />
        <StudioToggleRow
          label="Compact header"
          hint="Tighter title block · more chart space"
          checked={config.display.compact}
          onChange={(v) => update('compact', v)}
        />
      </StudioSection>

      {/* Title */}
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
        <p className="mt-1 text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
          Leave blank to use the default title.
        </p>
      </StudioSection>

      {/* Scope hint */}
      <StudioSection label="Scope">
        <p className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-[11.5px] text-slate-600 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          {persona === 'admin'
            ? 'Saving as a personal view. Org-wide and team-shared views are coming in a follow-up phase.'
            : persona === 'manager'
              ? 'Saving as a personal view. Team-shared views are coming in a follow-up phase.'
              : 'Saving as a personal view — visible only to you.'}
        </p>
      </StudioSection>
    </StudioShell>
  );
}

/* ============================================================ */

function VariantTile({
  selected,
  variant,
  label,
  description,
  onSelect,
}: {
  selected: boolean;
  variant: RevenueTrendVariant;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  const Icon =
    variant === 'line'
      ? LineIcon
      : variant === 'bar'
        ? BarChart3
        : variant === 'stacked-area'
          ? Layers
          : variant === 'flutter'
            ? Waves
            : AreaIcon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex h-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition',
        selected
          ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-300 dark:border-indigo-500/50 dark:bg-indigo-500/10'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:hover:border-[#2A2A2A] dark:hover:bg-[#111111]',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            selected
              ? 'text-indigo-600 dark:text-indigo-300'
              : 'text-slate-500 dark:text-[#A1A1AA]',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'text-[12px] font-semibold',
            selected
              ? 'text-indigo-800 dark:text-indigo-100'
              : 'text-slate-900 dark:text-[#FAFAFA]',
          )}
        >
          {label}
        </span>
      </div>
      <p className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
        {description}
      </p>
    </button>
  );
}

function MetricRow({
  selected,
  metric,
  label,
  description,
  onSelect,
}: {
  selected: boolean;
  metric: RevenueTrendMetric;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  const Icon =
    metric === 'conversionRate'
      ? Percent
      : metric === 'dealCount'
        ? Hash
        : metric === 'avgDealSize'
          ? TypeIcon
          : Sparkles;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition',
        selected
          ? 'border-indigo-300 bg-indigo-50/60 ring-1 ring-indigo-300 dark:border-indigo-500/50 dark:bg-indigo-500/10'
          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:hover:border-[#2A2A2A] dark:hover:bg-[#111111]',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 flex-shrink-0',
          selected
            ? 'text-indigo-600 dark:text-indigo-300'
            : 'text-slate-500 dark:text-[#A1A1AA]',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[12.5px] font-semibold',
            selected
              ? 'text-indigo-800 dark:text-indigo-100'
              : 'text-slate-900 dark:text-[#FAFAFA]',
          )}
        >
          {label}
        </div>
        <div className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
          {description}
        </div>
      </div>
      {selected ? (
        <Check className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-300" aria-hidden />
      ) : null}
    </button>
  );
}
