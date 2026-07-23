'use client';

import {
  ArrowRight,
  CalendarClock,
  ChevronRight,
  Clock,
  MoveRight,
  Sparkles,
  Trophy,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';

import type { DealHighlights } from '@/lib/dashboard/highlights';
import { formatCurrency } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

/**
 * Key deal highlights — what actually moved, without opening Pipeline.
 *
 * Five tabs over one card. Each tab shows at most five rows and links
 * through to the equivalently-filtered Deals view using the URL
 * contract in `lib/deals/filters.ts` (so the destination really is the
 * same set, not an approximation).
 *
 * An empty section collapses to a single muted line rather than a
 * full-height empty state — an empty card reading as loudly as a
 * populated one is what makes a sparse tenant look broken.
 */

type TabKey = keyof DealHighlights;

const TABS: Array<{ key: TabKey; label: string; icon: typeof Trophy }> = [
  { key: 'bigWins', label: 'Big wins', icon: Trophy },
  { key: 'progressed', label: 'Progressed', icon: MoveRight },
  { key: 'newDeals', label: 'New deals', icon: Sparkles },
  { key: 'atRisk', label: 'At risk', icon: Clock },
  { key: 'closingSoon', label: 'Closing soon', icon: CalendarClock },
];

export function DealHighlightsCard({
  highlights,
  ownerNames,
  rangeLabel,
  /** Pre-built `/dashboard/deals?...` hrefs, one per section. */
  viewAllHrefs,
  className,
}: {
  highlights: DealHighlights;
  ownerNames: Record<string, string>;
  rangeLabel: string;
  viewAllHrefs: Record<TabKey, string>;
  className?: string;
}) {
  const headingId = useId();
  const [active, setActive] = useState<TabKey>('bigWins');

  const counts: Record<TabKey, number> = {
    bigWins: highlights.bigWins.rows.length,
    progressed: highlights.progressed.rows.length,
    newDeals: highlights.newDeals.rows.length,
    atRisk: highlights.atRisk.rows.length,
    closingSoon: highlights.closingSoon.rows.length,
  };

  const ownerOf = (id: string | null) =>
    id ? (ownerNames[id] ?? 'Unassigned') : 'Unassigned';

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
            <Sparkles className="h-3 w-3" aria-hidden />
            Highlights
          </div>
          <h2
            id={headingId}
            className="mt-2 text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]"
          >
            Key deal highlights
          </h2>
          <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {rangeLabel} · movement worth knowing about without opening
            Pipeline
          </p>
        </div>
        <Link
          href={viewAllHrefs[active]}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          View all <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      <div
        role="tablist"
        aria-label="Highlight sections"
        className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-2 dark:border-[#1F1F1F]"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            onClick={() => setActive(t.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition',
              active === t.key
                ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/40'
                : 'text-slate-600 hover:bg-slate-50 dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
            )}
          >
            <t.icon className="h-3.5 w-3.5" aria-hidden />
            {t.label}
            <span
              className={cn(
                'font-mono text-[10px] tabular-nums',
                counts[t.key] === 0
                  ? 'text-slate-300 dark:text-[#3F3F46]'
                  : 'text-slate-500 dark:text-[#A1A1AA]',
              )}
            >
              {counts[t.key]}
              {sectionHasMore(highlights, t.key) ? '+' : ''}
            </span>
          </button>
        ))}
      </div>

      <div role="tabpanel" className="px-2 py-1.5">
        {active === 'bigWins' ? (
          highlights.bigWins.rows.length === 0 ? (
            <EmptyLine>No deals closed won in this period.</EmptyLine>
          ) : (
            <Rows>
              {highlights.bigWins.rows.map((d) => (
                <Row
                  key={d.id}
                  id={d.id}
                  name={d.name}
                  company={d.companyName}
                  meta={`${ownerOf(d.ownerId)} · won ${shortDate(d.closedAt)}`}
                  amount={formatCurrency(d.amountMinor, d.currency)}
                  badge={<StageBadge stage="won" />}
                />
              ))}
            </Rows>
          )
        ) : null}

        {active === 'progressed' ? (
          highlights.progressed.rows.length === 0 ? (
            <EmptyLine>No stage changes in this period.</EmptyLine>
          ) : (
            <Rows>
              {highlights.progressed.rows.map((d) => (
                <Row
                  key={`${d.id}-${d.changedAt.toISOString()}`}
                  id={d.id}
                  name={d.name}
                  company={d.companyName}
                  meta={`${ownerOf(d.ownerId)} · moved ${shortDate(d.changedAt)}`}
                  amount={formatCurrency(d.amountMinor, d.currency)}
                  badge={
                    <span className="inline-flex shrink-0 items-center gap-1 text-[9.5px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                      <StageBadge stage={d.fromStage} />
                      <ArrowRight className="h-2.5 w-2.5" aria-hidden />
                      <StageBadge stage={d.toStage} />
                    </span>
                  }
                />
              ))}
            </Rows>
          )
        ) : null}

        {active === 'newDeals' ? (
          highlights.newDeals.rows.length === 0 ? (
            <EmptyLine>No deals created in this period.</EmptyLine>
          ) : (
            <Rows>
              {highlights.newDeals.rows.map((d) => (
                <Row
                  key={d.id}
                  id={d.id}
                  name={d.name}
                  company={d.companyName}
                  meta={`${ownerOf(d.ownerId)} · created ${shortDate(d.createdAt)}`}
                  amount={formatCurrency(d.amountMinor, d.currency)}
                  badge={<StageBadge stage={d.stage} />}
                />
              ))}
            </Rows>
          )
        ) : null}

        {active === 'atRisk' ? (
          highlights.atRisk.rows.length === 0 ? (
            <EmptyLine>
              No open deal has been silent for {highlights.atRisk.idleDays}+
              days.
            </EmptyLine>
          ) : (
            <Rows>
              {highlights.atRisk.rows.map((d) => (
                <Row
                  key={d.id}
                  id={d.id}
                  name={d.name}
                  company={d.companyName}
                  meta={`${ownerOf(d.ownerId)} · silent ${d.daysSinceActivity}d`}
                  amount={formatCurrency(d.amountMinor, d.currency)}
                  badge={<StageBadge stage={d.stage} />}
                  tone="warn"
                />
              ))}
            </Rows>
          )
        ) : null}

        {active === 'closingSoon' ? (
          highlights.closingSoon.rows.length === 0 ? (
            <EmptyLine>
              No deals closing in the next {highlights.closingSoon.lookAheadDays}{' '}
              days.
            </EmptyLine>
          ) : (
            <Rows>
              {highlights.closingSoon.rows.map((d) => (
                <Row
                  key={d.id}
                  id={d.id}
                  name={d.name}
                  company={d.companyName}
                  meta={`${ownerOf(d.ownerId)} · ${
                    d.daysUntilClose === 0
                      ? 'closes today'
                      : `closes in ${d.daysUntilClose}d`
                  }`}
                  amount={formatCurrency(d.amountMinor, d.currency)}
                  badge={<StageBadge stage={d.stage} />}
                />
              ))}
            </Rows>
          )
        ) : null}
      </div>
    </section>
  );
}

function sectionHasMore(h: DealHighlights, key: TabKey): boolean {
  return h[key].hasMore;
}

/* ============================================================ */

function Rows({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
      {children}
    </ul>
  );
}

function Row({
  id,
  name,
  company,
  meta,
  amount,
  badge,
  tone = 'default',
}: {
  id: string;
  name: string;
  company: string | null;
  meta: string;
  amount: string;
  badge: React.ReactNode;
  tone?: 'default' | 'warn';
}) {
  return (
    <li>
      <Link
        href={`/dashboard/deals/${id}`}
        className="flex items-center gap-2.5 rounded-md px-3 py-2 transition hover:bg-slate-50 dark:hover:bg-[#181818]"
      >
        {badge}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-slate-800 dark:text-[#FAFAFA]">
            {name}
            {company ? (
              <span className="text-slate-400 dark:text-[#71717A]">
                {' '}
                · {company}
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              'block truncate text-[10.5px]',
              tone === 'warn'
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-slate-500 dark:text-[#A1A1AA]',
            )}
          >
            {meta}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-[#A1A1AA]">
          {amount}
        </span>
      </Link>
    </li>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-2 text-[11.5px] text-slate-400 dark:text-[#71717A]">
      {children}
    </p>
  );
}

const STAGE_BADGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]',
  qualified: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  proposal: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  negotiation: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  hold: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  won: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  lost: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};

function StageBadge({ stage }: { stage: DealStage }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide',
        STAGE_BADGE_STYLES[stage],
      )}
      title={DEAL_STAGE_LABELS[stage]}
    >
      {DEAL_STAGE_LABELS[stage].slice(0, 4)}
    </span>
  );
}

/**
 * Absolute, UTC-pinned dates only. This component is SSR'd and then
 * hydrated, so a `Date.now()`-relative label ("3m ago") would render
 * two different strings and trip a hydration mismatch.
 */
function shortDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
