'use client';

import { Check, Loader2, type LucideIcon } from 'lucide-react';
import { useCallback, useRef, useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

/**
 * Shared form primitives for the settings page. The pattern across
 * sections:
 *
 *   <SettingsSection title="..." description="...">
 *     <SettingsField ...>
 *       <ToggleRow ... />
 *       <InputRow ... />
 *     </SettingsField>
 *   </SettingsSection>
 *
 * `SettingsForm` is the outer wrapper that owns the dirty-tracking
 * state and the save button. Each section renders one form. On
 * submit, the save button fires the supplied action; toast on result.
 */

export type SettingsActionResult =
  | { ok: true }
  | { ok: false; message: string };

export function SettingsSection({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <header className="flex items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : null}
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              {description}
            </p>
          ) : null}
        </div>
      </header>
      {children}
    </section>
  );
}

/**
 * Form wrapper with dirty-tracking + Save button. Children render
 * the actual input rows; on Save we collect form data and pass to
 * the supplied action.
 */
export function SettingsForm<T extends Record<string, unknown>>({
  initial,
  action,
  collectChanges,
  children,
  submitLabel = 'Save changes',
}: {
  initial: T;
  action: (input: T) => Promise<SettingsActionResult>;
  /** Hook for the parent to read the latest values right before save. */
  collectChanges: () => T;
  children: ReactNode;
  submitLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const initialRef = useRef(initial);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const values = collectChanges();
      startTransition(async () => {
        const result = await action(values);
        if (result.ok) {
          initialRef.current = values;
          setSavedAt(Date.now());
          toast.success('Saved');
        } else {
          toast.error(result.message);
        }
      });
    },
    [action, collectChanges],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        {children}
      </div>
      <div className="flex items-center justify-end gap-3">
        {savedAt && Date.now() - savedAt < 5000 ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-300"
            aria-live="polite"
          >
            <Check className="h-3 w-3" aria-hidden />
            Saved
          </span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md bg-indigo-600 px-3 text-[12.5px] font-medium text-white shadow-sm transition-colors hover:bg-indigo-500',
            'disabled:cursor-not-allowed disabled:opacity-60',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40',
          )}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : null}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Labeled toggle row. The `name` becomes the form field id. */
export function ToggleRow({
  label,
  description,
  defaultChecked,
  name,
}: {
  label: string;
  description?: string;
  defaultChecked: boolean;
  name: string;
}) {
  return (
    <label className="flex items-start justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0 dark:border-[#1F1F1F]">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
          {label}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {description}
          </div>
        ) : null}
      </div>
      <span className="relative mt-0.5 inline-flex shrink-0 cursor-pointer">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          className="peer sr-only"
        />
        {/* Track */}
        <span
          aria-hidden
          className="h-5 w-9 rounded-full bg-slate-200 transition-colors peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500/40 dark:bg-[#27272A] dark:peer-checked:bg-indigo-500"
        />
        {/* Thumb */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4"
        />
      </span>
    </label>
  );
}

/** Labeled text input row. */
export function InputRow({
  label,
  description,
  defaultValue,
  name,
  type = 'text',
  placeholder,
}: {
  label: string;
  description?: string;
  defaultValue?: string | null;
  name: string;
  type?: 'text' | 'email';
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 border-b border-slate-100 py-2 last:border-b-0 dark:border-[#1F1F1F]">
      <div>
        <div className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
          {label}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {description}
          </div>
        ) : null}
      </div>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
      />
    </label>
  );
}

/** Labeled textarea row. */
export function TextareaRow({
  label,
  description,
  defaultValue,
  name,
  rows = 4,
  placeholder,
}: {
  label: string;
  description?: string;
  defaultValue?: string | null;
  name: string;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 border-b border-slate-100 py-2 last:border-b-0 dark:border-[#1F1F1F]">
      <div>
        <div className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
          {label}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {description}
          </div>
        ) : null}
      </div>
      <textarea
        name={name}
        defaultValue={defaultValue ?? ''}
        rows={rows}
        placeholder={placeholder}
        className="mt-1 w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
      />
    </label>
  );
}

/** Labeled select row. */
export function SelectRow({
  label,
  description,
  defaultValue,
  name,
  options,
}: {
  label: string;
  description?: string;
  defaultValue: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 border-b border-slate-100 py-2 last:border-b-0 dark:border-[#1F1F1F]">
      <div>
        <div className="text-[13px] font-medium text-slate-800 dark:text-[#FAFAFA]">
          {label}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {description}
          </div>
        ) : null}
      </div>
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
