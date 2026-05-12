import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-slate-500">
              {description}
            </p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'success' | 'warn' | 'danger' | 'muted';
}) {
  const toneClass: Record<typeof tone, string> = {
    default: 'text-slate-900',
    success: 'text-emerald-600',
    warn: 'text-amber-600',
    danger: 'text-red-600',
    muted: 'text-slate-500',
  };
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-xl tabular-nums ${toneClass[tone]}`}>
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 text-[11px] text-slate-500">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function StatusPill({
  status,
}: {
  status: string;
}) {
  const tones: Record<string, string> = {
    success: 'bg-emerald-100 text-emerald-700',
    completed: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
    failed: 'bg-red-100 text-red-700',
    skipped: 'bg-slate-100 text-slate-600',
    running: 'bg-blue-100 text-blue-700',
  };
  const tone = tones[status] ?? 'bg-slate-100 text-slate-600';
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {status}
    </span>
  );
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
