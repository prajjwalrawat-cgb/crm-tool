'use client';

import { Check, Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

/**
 * Small shared primitives for the lead-capture settings screens. Same tokens
 * as the rest of Settings (offerings-manager, stage gates).
 */

export const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#FAFAFA]';

export const selectCls = inputCls;

export function Card({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-slate-200 bg-white p-4 dark:border-[#262626] dark:bg-[#0F0F0F]', className)}>
      {title || actions ? (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title ? <h2 className="text-[13.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{hint}</p> : null}
    </div>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({
  variant = 'secondary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-indigo-600 text-white hover:bg-indigo-500',
        variant === 'secondary' && 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7] dark:hover:bg-[#181818]',
        variant === 'danger' && 'border border-rose-200 bg-white text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:bg-transparent dark:text-rose-300',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
        className,
      )}
    />
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-60',
        checked ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-[#333]',
      )}
    >
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Could not copy');
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span className="sr-only sm:not-sr-only">{done ? 'Copied' : label}</span>
    </Button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 pr-20 text-[11.5px] leading-relaxed text-slate-800 dark:border-[#262626] dark:bg-[#0A0A0A] dark:text-[#D4D4D8]">
        <code>{code}</code>
      </pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={code} />
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  processed: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  duplicate: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  received: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  inactive: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-[#1A1A1A] dark:text-[#A1A1AA] dark:ring-[#333]',
};

/** Status pill. Tone AND text carry the meaning, never colour alone. */
export function Badge({ tone, children }: { tone: keyof typeof STATUS_TONE | string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', STATUS_TONE[tone] ?? STATUS_TONE.inactive)}>
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center dark:border-[#333]">
      <div className="text-[13px] font-medium text-slate-700 dark:text-[#E4E4E7]">{title}</div>
      {children ? <div className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">{children}</div> : null}
    </div>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}
