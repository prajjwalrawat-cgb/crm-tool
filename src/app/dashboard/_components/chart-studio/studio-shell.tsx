'use client';

import { Check, Loader2, RotateCcw, Save, Sparkles, X } from 'lucide-react';
import {
  useEffect,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

/**
 * Shared chrome for every Chart Studio surface. Each chart-key gets
 * its own form sections (rendered as children), but the slide-in
 * panel, backdrop, header, footer + save/reset wiring all live here.
 *
 * The Cmd/Ctrl+K listener is owned by the chart wrapper (not this
 * shell) — each chart wires its own focus-gated shortcut to avoid
 * conflicts with the global ⌘K palette and with other charts on the
 * same dashboard. The shell just listens for Escape to close.
 *
 * Saved / error state is fully owned by the parent — keeps this
 * primitive synchronous and dumb.
 */
export function StudioShell({
  open,
  onClose,
  title,
  subtitle,
  children,
  saving,
  resetting,
  saveError,
  savedJustNow,
  onSave,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  saving: boolean;
  resetting: boolean;
  saveError: string | null;
  savedJustNow: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      aria-hidden={!open}
      className={cn(
        'fixed inset-0 z-50 transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
    >
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
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
              <Sparkles className="h-3 w-3" aria-hidden />
              Chart Studio
            </div>
            <h2 className="mt-2 truncate text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                {subtitle}
              </p>
            ) : null}
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

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        <footer className="flex items-center gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]/40">
          <button
            type="button"
            onClick={onReset}
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
              onClick={onSave}
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

/**
 * Shared section header for studio form blocks.
 */
export function StudioSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 last:mb-0">
      <h3 className="mb-1.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </h3>
      {children}
    </section>
  );
}

/**
 * Toggle switch row — used by every chart's appearance section.
 */
export function StudioToggleRow({
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
          checked ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-[#2A2A2A]',
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

/**
 * Shared CSS class string for the chart focus halo. Apply to the
 * outer chart `<section>` so the focus state lifts the chart with a
 * soft drop shadow + indigo ring without shifting surrounding layout.
 */
export const CHART_FOCUS_CLASS =
  'group/chart relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] outline-none transition-all duration-200 focus-within:-translate-y-0.5 focus-within:shadow-[0_18px_38px_-18px_rgba(99,102,241,0.45),0_0_0_1px_rgba(99,102,241,0.18)] focus-within:ring-1 focus-within:ring-indigo-400/30 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]';
