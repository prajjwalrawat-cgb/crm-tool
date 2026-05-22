'use client';

import {
  AreaChart as AreaIcon,
  BarChart3,
  Check,
  Layers,
  LineChart as LineIcon,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

import {
  DEFAULT_REVENUE_TREND_CONFIG,
  REVENUE_TREND_VARIANTS,
  type ChartKey,
  type RevenueTrendConfig,
  type RevenueTrendVariant,
} from '@/lib/chart-studio/config';
import type { Persona } from '@/lib/personas';
import { cn } from '@/lib/utils';

import {
  resetChartViewAction,
  saveChartViewAction,
} from './actions';

/**
 * Chart Studio — the hidden power-user surface. Slides in from the
 * right when the user is focused on a chart and hits Cmd/Ctrl+K (or
 * clicks the discreet gear button that surfaces on hover).
 *
 * What it offers right now (Phase 17-G first cut):
 *   - Chart-type switcher (area · stacked-area · line · bar) gated by
 *     chart-key compatibility.
 *   - Display toggles (legend · smooth · animation · lost-line ·
 *     compact · cumulative).
 *   - Title rename.
 *   - Save (persists per-user) · Reset (restores defaults).
 *   - Persona-aware scope footer — members save personal views; manager
 *     + admin can save team/org-wide views (UI hint only this turn;
 *     server enforces the actual gate).
 *
 * What's NOT here yet (intentionally deferred to a follow-up phase):
 *   - Data source selector (new server queries needed per metric).
 *   - X/Y axis dimension picker (server-side query routing).
 *   - Multiple named views per chart + view picker.
 *
 * Keyboard: Escape closes; focus traps to the first interactive
 * element on open; Enter on the title input commits to live state.
 */
export function ChartStudioPanel({
  chartKey,
  chartTitle,
  open,
  onClose,
  config,
  onConfigChange,
  titleOverride,
  onTitleChange,
  persona,
}: {
  chartKey: ChartKey;
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

  // Auto-focus the title input on open. Esc closes.
  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setSavedJustNow(false);
    const timer = setTimeout(() => {
      titleInputRef.current?.focus();
    }, 60);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  function update<K extends keyof RevenueTrendConfig['display']>(
    key: K,
    value: RevenueTrendConfig['display'][K],
  ) {
    onConfigChange((prev) => ({
      ...prev,
      display: { ...prev.display, [key]: value },
    }));
  }

  function setVariant(variant: RevenueTrendVariant) {
    onConfigChange((prev) => ({ ...prev, variant }));
  }

  function handleSave() {
    setSaveError(null);
    setSavedJustNow(false);
    startSaveTransition(async () => {
      const result = await saveChartViewAction({
        chartKey,
        variant: config.variant,
        display: config.display,
        title: titleOverride?.trim() ? titleOverride.trim() : null,
        roleScope: 'user',
      });
      if (!result.ok) {
        setSaveError(result.message);
        return;
      }
      setSavedJustNow(true);
      // Fade the saved confirmation back out after a moment.
      setTimeout(() => setSavedJustNow(false), 2000);
    });
  }

  function handleReset() {
    startResetTransition(async () => {
      const result = await resetChartViewAction({ chartKey });
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
    <div
      aria-hidden={!open}
      className={cn(
        'fixed inset-0 z-50 transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
    >
      {/* Translucent backdrop with blur — clicking outside closes. */}
      <button
        type="button"
        aria-label="Close Chart Studio"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        className={cn(
          'absolute inset-0 bg-slate-900/30 backdrop-blur-[2px] transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Chart Studio"
        className={cn(
          'absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-slate-200 bg-white/95 shadow-2xl backdrop-blur-xl transition-transform duration-250 ease-out dark:border-[#1F1F1F] dark:bg-[#0A0A0A]/95',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Sparkles className="h-3 w-3" aria-hidden />
              Chart Studio
            </div>
            <h2 className="mt-2 truncate text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {titleOverride?.trim() || chartTitle}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
              Personalize how this chart looks. Saves to your account only.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 dark:hover:bg-[#181818] dark:hover:text-[#FAFAFA]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Title rename */}
          <Section label="Title" icon={null}>
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
          </Section>

          {/* Chart type */}
          <Section label="Chart type">
            <div className="grid grid-cols-2 gap-2">
              {REVENUE_TREND_VARIANTS.map((v) => (
                <VariantTile
                  key={v.value}
                  selected={config.variant === v.value}
                  variant={v.value}
                  label={v.label}
                  description={v.description}
                  onSelect={() => setVariant(v.value)}
                />
              ))}
            </div>
          </Section>

          {/* Display options */}
          <Section label="Display">
            <ToggleRow
              label="Smooth lines"
              hint="Monotone curves vs. straight segments"
              checked={config.display.smoothLines}
              onChange={(v) => update('smoothLines', v)}
            />
            <ToggleRow
              label="Animations"
              hint="Subtle enter animations on render"
              checked={config.display.animated}
              onChange={(v) => update('animated', v)}
            />
            <ToggleRow
              label="Show legend"
              hint="Footer color-coded series strip"
              checked={config.display.showLegend}
              onChange={(v) => update('showLegend', v)}
            />
            <ToggleRow
              label="Lost-revenue line"
              hint="Dashed rose-tone overlay"
              checked={config.display.showLostLine}
              onChange={(v) => update('showLostLine', v)}
            />
            <ToggleRow
              label="Cumulative view"
              hint="Running totals over the window"
              checked={config.display.cumulative}
              onChange={(v) => update('cumulative', v)}
            />
            <ToggleRow
              label="Compact header"
              hint="Tighter title block · more chart space"
              checked={config.display.compact}
              onChange={(v) => update('compact', v)}
            />
          </Section>

          {/* Scope hint */}
          <Section label="Scope">
            <p className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-[11.5px] text-slate-600 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
              {persona === 'admin'
                ? 'Saving as a personal view. Org-wide and team-shared views are coming in a follow-up phase.'
                : persona === 'manager'
                  ? 'Saving as a personal view. Team-shared views are coming in a follow-up phase.'
                  : 'Saving as a personal view — visible only to you.'}
            </p>
          </Section>
        </div>

        {/* Footer */}
        <footer className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]/40">
          <button
            type="button"
            onClick={handleReset}
            disabled={resetting || saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-[#181818]"
          >
            {resetting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            )}
            Reset
          </button>
          <div className="ml-auto flex items-center gap-2">
            {saveError ? (
              <span
                role="alert"
                className="text-[11px] text-rose-600 dark:text-rose-300"
              >
                {saveError}
              </span>
            ) : savedJustNow ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                <Check className="h-3 w-3" aria-hidden />
                Saved
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || resetting}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden />
              )}
              Save view
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

/* ============================================================ */

function Section({
  label,
  icon = null,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#A1A1AA]">
        {icon}
        {label}
      </h3>
      {children}
    </section>
  );
}

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
          : AreaIcon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group/tile flex h-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition',
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

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 transition hover:bg-slate-50/60 dark:hover:bg-[#181818]">
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-slate-900 dark:text-[#FAFAFA]">
          {label}
        </div>
        {hint ? (
          <div className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
            {hint}
          </div>
        ) : null}
      </div>
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-block h-4 w-7 flex-shrink-0 cursor-pointer rounded-full transition-colors',
          checked
            ? 'bg-indigo-500'
            : 'bg-slate-300 dark:bg-[#2A2A2A]',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </label>
  );
}
