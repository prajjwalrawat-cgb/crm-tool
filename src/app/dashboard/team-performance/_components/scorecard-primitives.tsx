import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import {
  deltaDirection,
  describeDelta,
  formatDelta,
  type Delta,
} from '@/lib/dashboard/delta';
import { periodLabel, type ScorecardDelta } from '@/lib/team-analytics/deltas';
import { cn } from '@/lib/utils';

/**
 * Shared chrome for the team scorecard's four tables.
 *
 * The page is dense by design — five reps across four aggregates is a lot
 * of cells — so every table gets the same shell: a titled section, a
 * horizontally scrollable frame (the page body must never scroll
 * sideways), sticky-left rep names, and one convention for what a number
 * looks like. Anything that varies between sections lives in that
 * section's own file.
 */

export function Section({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned slot in the header — a legend or a link. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 max-w-3xl text-[11.5px] leading-relaxed text-slate-500 dark:text-[#A1A1AA]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {aside ?? null}
      </header>
      {children}
    </section>
  );
}

/** Horizontal scroll lives here and nowhere else. */
export function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[640px] border-collapse text-[12px]">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = 'right',
  title,
  sticky = false,
  className,
  colSpan,
  rowSpan,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Hover text — used to carry each field's "why it matters" line. */
  title?: string;
  sticky?: boolean;
  className?: string;
  /** Set on a two-tier header: a group cell spans its fields. */
  colSpan?: number;
  /** Set on a two-tier header: an ungrouped column spans both rows. */
  rowSpan?: number;
}) {
  return (
    <th
      title={title}
      colSpan={colSpan}
      rowSpan={rowSpan}
      scope={colSpan && colSpan > 1 ? 'colgroup' : 'col'}
      className={cn(
        'whitespace-nowrap border-b border-slate-200 pb-1.5 pt-0.5 text-[10.5px] font-medium uppercase tracking-wide text-slate-400 dark:border-[#1F1F1F] dark:text-[#71717A]',
        align === 'left' && 'text-left',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        sticky &&
          'sticky left-0 z-10 bg-white pr-3 dark:bg-[#0A0A0A]',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = 'right',
  muted = false,
  sticky = false,
  title,
  className,
}: {
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  muted?: boolean;
  sticky?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <td
      title={title}
      className={cn(
        'whitespace-nowrap border-b border-slate-100 py-2 tabular-nums dark:border-[#151515]',
        align === 'left' && 'text-left',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        muted
          ? 'text-slate-400 dark:text-[#71717A]'
          : 'text-slate-700 dark:text-[#D4D4D8]',
        sticky &&
          'sticky left-0 z-10 bg-white pr-3 font-medium text-slate-900 dark:bg-[#0A0A0A] dark:text-[#FAFAFA]',
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * The rep's name cell, with their role underneath. Sticky so a name stays
 * readable while the numbers scroll.
 *
 * `href` turns the name into a drill-through to that rep's deals, scoped to
 * whatever cohort the table counts (see `./drill-links`). Without one it
 * renders as plain text — a link that went somewhere unfiltered would be
 * worse than none.
 */
export function RepCell({
  name,
  role,
  href,
  className,
}: {
  name: string;
  role: string | null;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="block leading-tight">{name}</span>
      {role ? (
        <span className="block text-[10px] font-normal capitalize text-slate-400 dark:text-[#71717A]">
          {role}
        </span>
      ) : null}
    </>
  );
  return (
    <Td sticky align="left" className={className}>
      {href ? (
        <Link
          href={href}
          title={`Open ${name}'s deals`}
          className="block hover:text-indigo-600 hover:underline dark:hover:text-indigo-300"
        >
          {body}
        </Link>
      ) : (
        body
      )}
    </Td>
  );
}

/**
 * A number that opens the rows behind it.
 *
 * Renders as plain text when `href` is absent — a cell with nothing to drill
 * into (a zero, an "n/a") should not advertise a click that lands on an empty
 * list.
 */
export function DrillCell({
  href,
  title,
  children,
  align = 'right',
  muted = false,
  className,
}: {
  href?: string | null;
  title?: string;
  children: ReactNode;
  align?: 'left' | 'right' | 'center';
  muted?: boolean;
  className?: string;
}) {
  return (
    <Td align={align} muted={muted} className={className} title={title}>
      {href ? (
        <Link
          href={href}
          className="hover:text-indigo-600 hover:underline dark:hover:text-indigo-300"
        >
          {children}
        </Link>
      ) : (
        children
      )}
    </Td>
  );
}

export type ChipTone = 'good' | 'warn' | 'bad' | 'neutral';

const CHIP_TONES: Record<ChipTone, string> = {
  good: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  bad: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
  neutral:
    'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-[#151515] dark:text-[#A1A1AA] dark:ring-[#262626]',
};

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset',
        CHIP_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A percentage rendered as a number over a thin bar. Used for both
 * attainment and completeness so "how full is this" reads the same way in
 * both tables.
 *
 * `tone` is passed in rather than derived from the ratio: 60% attainment
 * halfway through the year is fine and 60% completeness is not, and one
 * shared threshold would have to be wrong for one of them.
 */
export function PctCell({
  ratio,
  tone,
  label,
  title,
  delta,
}: {
  ratio: number;
  tone: ChipTone;
  /** Overrides the rendered text (e.g. "—" when nothing applies). */
  label?: string;
  title?: string;
  /** Optional movement badge, rendered beside the number at table weight. */
  delta?: ReactNode;
}) {
  const pct = Math.round(ratio * 100);
  const width = Math.min(100, Math.max(0, pct));
  const barTone: Record<ChipTone, string> = {
    good: 'bg-emerald-500',
    warn: 'bg-amber-500',
    bad: 'bg-rose-500',
    neutral: 'bg-slate-300 dark:bg-[#3F3F46]',
  };
  return (
    <Td title={title}>
      <span className="flex items-center justify-end gap-1 leading-tight">
        {label ?? `${pct}%`}
        {delta}
      </span>
      <span className="mt-0.5 block h-1 w-full min-w-[36px] overflow-hidden rounded-full bg-slate-100 dark:bg-[#1F1F1F]">
        <span
          className={cn('block h-full rounded-full', barTone[tone])}
          style={{ width: `${width}%` }}
        />
      </span>
    </Td>
  );
}

/**
 * The footnote strip under a table. Every disclosure on this page renders
 * through here so they all look like what they are: caveats on the numbers
 * above, not extra findings.
 */
export function Notes({ notes }: { notes: (string | null)[] }) {
  const visible = notes.filter((n): n is string => Boolean(n));
  if (visible.length === 0) return null;
  return (
    <ul className="mt-2.5 space-y-1 border-t border-slate-100 pt-2.5 dark:border-[#1F1F1F]">
      {visible.map((n) => (
        <li key={n} className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
          {n}
        </li>
      ))}
    </ul>
  );
}

/** Shown in place of a table when a section genuinely has nothing to say. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md bg-slate-50 px-3 py-4 text-center text-[12px] text-slate-500 dark:bg-[#111111] dark:text-[#A1A1AA]">
      {children}
    </p>
  );
}

/**
 * Movement since the last month-close snapshot.
 *
 * The arithmetic is `@/lib/dashboard/delta`, shared with both dashboards —
 * this only renders it. Two things it does NOT do:
 *
 *   · It never colours by direction alone. `higherIsBetter` comes from the
 *     metric's own entry in `DELTA_HIGHER_IS_BETTER`, so "close dates pushed,
 *     down 4" is green and "attainment, down 4 pts" is red. A single colour
 *     rule across the strip would congratulate a team for pushing more deals.
 *   · It never renders a missing baseline as 0%. Until the first snapshot
 *     exists the badge says so in words, because a grey "0%" is
 *     indistinguishable from a month in which genuinely nothing moved.
 */
export function DeltaBadge({
  delta: scorecardDelta,
  formatChange = (n) => String(Math.round(n)),
  variant = 'table',
}: {
  delta: ScorecardDelta;
  /** Renders the magnitude of an absolute change in the metric's own units. */
  formatChange?: (magnitude: number) => string;
  /** `tile` spells out a missing baseline; `table` shows a quiet dash. */
  variant?: 'tile' | 'table';
}) {
  const { delta, higherIsBetter, baselinePeriod } = scorecardDelta;

  if (delta.kind === 'none' || baselinePeriod === null) {
    const title =
      'No comparison yet — the first month-close snapshot for this workspace has not been captured.';
    return variant === 'tile' ? (
      <span
        title={title}
        className="text-[10px] font-medium text-slate-400 dark:text-[#71717A]"
      >
        no comparison yet
      </span>
    ) : (
      <span
        title={title}
        className="text-[10px] text-slate-300 dark:text-[#52525B]"
      >
        —
      </span>
    );
  }

  const direction = deltaDirection(delta);
  // "New this period" and "flat" are facts, not verdicts — neither earns a
  // colour, the same rule the dashboard KPI strip follows.
  const good =
    delta.kind === 'new' || direction === null
      ? null
      : (direction === 'up') === higherIsBetter;

  return (
    <span
      title={`${describeDelta(delta, 'period', formatChange)} Baseline: ${periodLabel(
        baselinePeriod,
      )} month close.`}
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold tabular-nums',
        good === null
          ? 'bg-slate-50 text-slate-500 dark:bg-[#181818] dark:text-[#A1A1AA]'
          : good
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
            : 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
      )}
    >
      {direction === null ? (
        <Minus className="h-2.5 w-2.5" aria-hidden />
      ) : direction === 'up' ? (
        <ArrowUp className="h-2.5 w-2.5" aria-hidden />
      ) : (
        <ArrowDown className="h-2.5 w-2.5" aria-hidden />
      )}
      {formatDelta(delta, formatChange)}
    </span>
  );
}

/** Re-exported so section files import one delta surface, not two. */
export type { Delta };
