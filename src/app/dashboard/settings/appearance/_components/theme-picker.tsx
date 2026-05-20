'use client';

import { Check, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Theme picker — three-up card layout (Light / Dark / System) backed by
 * next-themes. Each card shows a preview swatch so the choice is visual,
 * not just textual.
 *
 * Hydration guard: next-themes can't know the current theme on the server,
 * so the picker renders an inert state until the client mounts. Without
 * the guard, the selected ring would flash on hydration.
 */
type Option = {
  value: 'light' | 'dark' | 'system';
  label: string;
  hint: string;
  icon: LucideIcon;
};

const OPTIONS: readonly Option[] = [
  { value: 'light', label: 'Light', hint: 'Default daylight palette', icon: Sun },
  { value: 'dark', label: 'Dark', hint: 'Low-glare night palette', icon: Moon },
  { value: 'system', label: 'System', hint: 'Follow OS preference', icon: Monitor },
];

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Mount guard: next-themes can't resolve the active theme on the
    // server, so we render an inert state until the client hydrates.
    // Documented in next-themes README ("Avoid Hydration Mismatch").
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const selected = mounted && theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setTheme(opt.value)}
            aria-pressed={selected}
            className={cn(
              'group relative flex flex-col gap-2 rounded-lg border p-3 text-left transition-all hover:-translate-y-px hover:shadow-md',
              selected
                ? 'border-indigo-400 ring-2 ring-indigo-500/40 dark:border-indigo-500'
                : 'border-slate-200 hover:border-slate-300 dark:border-[#1F1F1F] dark:hover:border-slate-700',
            )}
          >
            <ThemeSwatch value={opt.value} />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Icon className="h-3.5 w-3.5 text-slate-500 dark:text-[#A1A1AA]" aria-hidden />
                <span className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                  {opt.label}
                </span>
              </div>
              {selected ? (
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-600 text-white">
                  <Check className="h-2.5 w-2.5" aria-hidden />
                </span>
              ) : null}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">{opt.hint}</div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tiny preview of the chrome each theme renders — sidebar strip + body
 * surface + accent dot. Keeps the picker visual without dragging in a
 * full mini-app render.
 */
function ThemeSwatch({ value }: { value: 'light' | 'dark' | 'system' }) {
  if (value === 'system') {
    return (
      <div className="flex h-16 overflow-hidden rounded-md border border-slate-200 dark:border-[#1F1F1F]">
        <SwatchLight className="w-1/2" />
        <SwatchDark className="w-1/2" />
      </div>
    );
  }
  if (value === 'dark') return <SwatchDark />;
  return <SwatchLight />;
}

function SwatchLight({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-16 overflow-hidden rounded-md border border-slate-200',
        className,
      )}
    >
      <div className="w-1/3 bg-white">
        <div className="mt-1.5 ml-1.5 h-1 w-5 rounded bg-indigo-500" />
        <div className="mt-1 ml-1.5 h-0.5 w-4 rounded bg-slate-300" />
        <div className="mt-1 ml-1.5 h-0.5 w-3 rounded bg-slate-300" />
      </div>
      <div className="flex-1 bg-slate-50">
        <div className="m-1.5 h-2.5 w-8 rounded bg-white shadow-sm" />
        <div className="ml-1.5 h-1 w-10 rounded bg-slate-200" />
      </div>
    </div>
  );
}

function SwatchDark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-16 overflow-hidden rounded-md border border-slate-700',
        className,
      )}
    >
      <div className="w-1/3 bg-[#111827]">
        <div className="mt-1.5 ml-1.5 h-1 w-5 rounded bg-indigo-400" />
        <div className="mt-1 ml-1.5 h-0.5 w-4 rounded bg-slate-600" />
        <div className="mt-1 ml-1.5 h-0.5 w-3 rounded bg-slate-600" />
      </div>
      <div className="flex-1 bg-[#0B1020]">
        <div className="m-1.5 h-2.5 w-8 rounded bg-[#1F2937] shadow-sm" />
        <div className="ml-1.5 h-1 w-10 rounded bg-slate-700" />
      </div>
    </div>
  );
}
