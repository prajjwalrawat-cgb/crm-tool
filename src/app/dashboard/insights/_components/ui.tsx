'use client';

import { AlertTriangle, Download, Inbox } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { cn } from '@/lib/utils';

/**
 * Shared bits for /dashboard/insights. Chart colours are CSS variables set
 * on `VIZ` wrappers, with their own dark-mode steps (validated reference
 * palette: blue #2a78d6 light / #3987e5 dark). Text always uses text
 * tokens, never the series colour.
 */
export const VIZ =
  '[--viz-1:#2a78d6] dark:[--viz-1:#3987e5] [--viz-2:#eb6834] dark:[--viz-2:#d95926] [--viz-grid:#ece4de] dark:[--viz-grid:#3b322e] [--viz-axis:#7a6e68] dark:[--viz-axis:#a89c98]';

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <Inbox className="h-5 w-5 text-slate-400" aria-hidden />
      <p className="mt-2 text-[13px] font-medium text-slate-700">{title}</p>
      {body && <p className="mt-0.5 max-w-md text-[12px] text-slate-500">{body}</p>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {message}
    </div>
  );
}

export function Bone({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} aria-hidden />;
}

export function Card({ title, actions, children, className }: { title?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-lg border border-slate-200 bg-white p-4 shadow-sm', className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const TABS = [
  { href: '/dashboard/insights', label: 'Overview' },
  { href: '/dashboard/insights/funnel', label: 'Funnel' },
  { href: '/dashboard/insights/sources', label: 'Lead sources' },
  { href: '/dashboard/insights/reps', label: 'Rep productivity' },
  { href: '/dashboard/insights/sla', label: 'SLA' },
  { href: '/dashboard/insights/pipeline', label: 'Team pipeline' },
  { href: '/dashboard/insights/stale', label: 'Stale leads' },
  { href: '/dashboard/insights/leaderboard', label: 'Leaderboard' },
  { href: '/dashboard/insights/saved', label: 'Saved' },
];

/** Tab row. Keeps the range query string across tabs so the period is shared. */
export function InsightsTabs() {
  const pathname = usePathname();
  const sp = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of ['range', 'from', 'to', 'compareTo']) {
    const v = sp.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  return (
    <nav aria-label="Sales reports" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {TABS.map((t) => {
        const active = t.href === '/dashboard/insights' ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={qs ? `${t.href}?${qs}` : t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition',
              active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['mtd', 'Month to date'],
  ['custom', 'Custom'],
] as const;

/** Date range + compare control; state lives in the URL. */
export function RangeControl({ range, from, to, compareTo, showCompare = true }: { range: string; from: string; to: string; compareTo: string; showCompare?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-[12.5px]', pending && 'opacity-70')}>
      <label className="sr-only" htmlFor="range-preset">
        Period
      </label>
      <select
        id="range-preset"
        value={range}
        onChange={(e) => set(e.target.value === 'custom' ? { range: 'custom', from, to } : { range: e.target.value, from: null, to: null })}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-800"
      >
        {PRESETS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {range === 'custom' && (
        <>
          <input aria-label="From" type="date" value={from} max={to} onChange={(e) => set({ from: e.target.value })} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-800" />
          <span className="text-slate-400">to</span>
          <input aria-label="To" type="date" value={to} min={from} onChange={(e) => set({ to: e.target.value })} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-800" />
        </>
      )}
      {showCompare && (
        <>
          <label className="sr-only" htmlFor="range-compare">
            Compare with
          </label>
          <select id="range-compare" value={compareTo} onChange={(e) => set({ compareTo: e.target.value })} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-800">
            <option value="previous">vs previous period</option>
            <option value="yoy">vs same period last year</option>
          </select>
        </>
      )}
    </div>
  );
}

export function ExportLink({ report, query, label = 'Export CSV' }: { report: string; query: Record<string, string>; label?: string }) {
  const qs = new URLSearchParams({ report, format: 'csv', ...query }).toString();
  return (
    <a href={`/api/reports/export?${qs}`} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50">
      <Download className="h-3.5 w-3.5" aria-hidden />
      {label}
    </a>
  );
}

/** "▲ +12% (better)" with colour AND arrow AND word, so it never relies on colour alone. */
export function DeltaText({ text, good }: { text: string; good: boolean | null }) {
  return (
    <span className={cn('text-[11.5px] font-medium', good === null ? 'text-slate-500' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400')}>
      {text}
      {good !== null && <span className="sr-only">{good ? ' (better)' : ' (worse)'}</span>}
    </span>
  );
}
