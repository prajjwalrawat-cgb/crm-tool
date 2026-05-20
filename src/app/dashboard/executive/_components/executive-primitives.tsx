import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Executive dashboard primitives. These are the layout building blocks
 * the `/dashboard/executive` page composes from existing runners.
 *
 * Why a new primitives file (vs reusing report sections directly): the
 * executive view is denser — it stacks 5+ slices on one page — so each
 * slice needs a tighter chrome, a consistent CTA pattern, and uniform
 * spacing. Reusing the report section components verbatim would force
 * each slice to bring its own KPI band + chart at full size, which
 * blows up the page height.
 */

/**
 * Top-level section wrapper. Renders a labelled card with an optional
 * subtitle and an optional "View details" action slot in the top-right.
 *
 * Layout: title left, action right, body below. The action slot is
 * meant for a Link to the matching `/dashboard/reports/<id>` page so a
 * viewer can drill into any slice that catches their eye.
 */
export function ExecutiveSection({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{subtitle}</p>
          ) : null}
        </div>
        {action ?? null}
      </header>
      {children}
    </section>
  );
}

/**
 * Standard "drill into the matching report" link for an ExecutiveSection
 * action slot. Centralized here so the chevron + hover state is uniform
 * across the page.
 */
export function SectionLink({
  href,
  label = 'Open report',
}: {
  href: string;
  label?: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
    >
      {label}
      <ArrowRight className="h-3 w-3" aria-hidden />
    </Link>
  );
}

/**
 * Responsive grid for arranging InsightCards / MetricCards / charts
 * within a section. Defaults to a 12-column grid; cells choose their
 * column span via `span` on `<DashboardGridCell>`.
 *
 * Why a grid instead of flex: the executive layout has wide and narrow
 * cells side-by-side (e.g. a 2/3 chart + 1/3 highlights). A 12-col grid
 * lets each section express that without each one inventing its own
 * breakpoint logic.
 */
export function DashboardGrid({
  children,
  className,
  cols = 12,
}: {
  children: ReactNode;
  className?: string;
  cols?: 6 | 12;
}) {
  return (
    <div
      className={cn(
        'grid gap-3',
        cols === 12 ? 'grid-cols-12' : 'grid-cols-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DashboardGridCell({
  span = 12,
  className,
  children,
}: {
  /** Mobile-first base span; defaults to full row. */
  span?: 3 | 4 | 6 | 8 | 12;
  /** Desktop (lg) span. Defaults to the same as `span`. */
  className?: string;
  children: ReactNode;
}) {
  const colMap: Record<number, string> = {
    3: 'col-span-12 md:col-span-6 lg:col-span-3',
    4: 'col-span-12 md:col-span-6 lg:col-span-4',
    6: 'col-span-12 lg:col-span-6',
    8: 'col-span-12 lg:col-span-8',
    12: 'col-span-12',
  };
  return <div className={cn(colMap[span], className)}>{children}</div>;
}

/**
 * Larger sibling of MetricCard — meant for a single insight with a
 * one-line "why it matters" hint. Use for hero numbers that deserve
 * vertical breathing room (e.g. forecast likely, top performer).
 */
export function InsightCard({
  label,
  value,
  hint,
  tone = 'neutral',
  href,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  /** If provided, the whole card becomes a link. */
  href?: string;
  className?: string;
}) {
  const toneRing: Record<typeof tone, string> = {
    info: 'border-indigo-200/80 bg-gradient-to-br from-indigo-50/60 to-white dark:border-indigo-500/30 dark:from-indigo-500/10 dark:to-[#111827]',
    success: 'border-emerald-200/80 bg-gradient-to-br from-emerald-50/60 to-white dark:border-emerald-500/30 dark:from-emerald-500/10 dark:to-[#111827]',
    warning: 'border-amber-200/80 bg-gradient-to-br from-amber-50/60 to-white dark:border-amber-500/30 dark:from-amber-500/10 dark:to-[#111827]',
    danger: 'border-rose-200/80 bg-gradient-to-br from-rose-50/60 to-white dark:border-rose-500/30 dark:from-rose-500/10 dark:to-[#111827]',
    neutral: 'border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
  };
  const valueTone: Record<typeof tone, string> = {
    info: 'text-indigo-700 dark:text-indigo-300',
    success: 'text-emerald-700 dark:text-emerald-300',
    warning: 'text-amber-800 dark:text-amber-300',
    danger: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-900 dark:text-[#FAFAFA]',
  };

  const body = (
    <>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-2xl font-semibold tabular-nums leading-tight',
          valueTone[tone],
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-slate-500 dark:text-[#A1A1AA]">
        {hint ?? ' '}
      </div>
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          'block rounded-md border p-4 transition-all hover:-translate-y-px hover:shadow-md',
          toneRing[tone],
          className,
        )}
      >
        {body}
      </Link>
    );
  }

  return (
    <div
      className={cn(
        'rounded-md border p-4 transition-shadow hover:shadow-sm',
        toneRing[tone],
        className,
      )}
    >
      {body}
    </div>
  );
}

/**
 * One row in the Attention Queue — a deal/task/email that needs the
 * exec's eye. Severity drives the dot color so the user can scan a
 * list of 5–10 items and visually triage.
 */
export function AttentionItem({
  title,
  detail,
  meta,
  severity = 'info',
  href,
}: {
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  severity?: 'info' | 'warning' | 'danger';
  href?: string;
}) {
  const dotTone: Record<typeof severity, string> = {
    info: 'bg-indigo-500',
    warning: 'bg-amber-500',
    danger: 'bg-rose-500',
  };

  const body = (
    <div className="flex items-start gap-3 px-3 py-2 transition-colors hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
      <span
        className={cn(
          'mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full',
          dotTone[severity],
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-slate-900 dark:text-[#FAFAFA]">
          {title}
        </div>
        {detail ? (
          <div className="mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {detail}
          </div>
        ) : null}
      </div>
      {meta ? (
        <div className="ml-2 flex-shrink-0 text-right font-mono text-[10.5px] tabular-nums text-slate-500 dark:text-[#A1A1AA]">
          {meta}
        </div>
      ) : null}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block">
        {body}
      </Link>
    );
  }
  return body;
}

/**
 * Container for a list of AttentionItems with consistent dividers.
 * Used by the Attention section AND by inline lists inside other
 * sections (e.g. "Top performers", "Stalled deals").
 */
export function AttentionList({
  children,
  emptyMessage = 'Nothing to flag — you\'re all clear.',
}: {
  children: ReactNode;
  emptyMessage?: string;
}) {
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some(Boolean);
  if (!hasItems) {
    return (
      <div className="px-3 py-6 text-center text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
        {emptyMessage}
      </div>
    );
  }
  return <div className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">{children}</div>;
}
