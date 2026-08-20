import { currentUser } from '@/lib/auth/server';
import {
  ChevronRight,
  Cog,
  Gauge,
  Radar,
  Sparkles,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import Link from 'next/link';

import {
  readRevenueTrendView,
  readStageConversionView,
  readStageDonutView,
} from '@/lib/chart-studio/queries';
import { getInboxCounts } from '@/lib/communications/threads/queries';
import { getDealHighlights } from '@/lib/dashboard/highlights';
import { getDashboardKpis } from '@/lib/dashboard/kpis';
import { getDashboardOverview, getRevenueTrend } from '@/lib/dashboard/queries';
import { isoDay, type DashboardRange } from '@/lib/dashboard/range';
import { dealFiltersToSearchParams } from '@/lib/deals/filters';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import {
  getRecommendationInsight,
  getRiskFlagInsight,
} from '@/lib/intelligence/runner';
import {
  getAiInvocationStats,
  getEmailDeliveryStats,
  getWorkflowStats,
} from '@/lib/ops/queries';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import type { DateRangePreset, OwnerScope } from '@/lib/reports/types';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { DashboardRangeFilter } from '../dashboard-range-filter';
import { DealHighlightsCard } from '../deal-highlights';
import { KpiStrip } from '../kpi-strip';
import { buildOpsChecks, OpsStatusStrip } from '../ops-status-strip';
import { RevenueTrendChart } from '../revenue-trend-chart';
import { StageConversionBars } from '../stage-conversion-bars';
import { StageDonut } from '../stage-donut';

import { Greeting } from './greeting';
import { RepFilter } from './rep-filter';

/**
 * Admin Home — the org's main dashboard.
 *
 * Layout, top to bottom:
 *   1. Filters (owner scope + shared date range)
 *   2. KPI strip — headline numbers with vs-prior-period deltas
 *   3. Revenue trend — weekly pipeline bars + won/lost overlay
 *   4. Pipeline by stage (snapshot) + deal-count donut
 *   5. Key deal highlights — what actually moved
 *   6. Operations, collapsed to a one-line status strip
 *   7. AI signals + admin shortcuts
 *
 * WHICH WIDGETS FOLLOW THE RANGE PICKER — the whole list, because
 * "some of them" is what made this page argue with itself:
 *
 *   FOLLOWS `?range=`     2 (win rate, avg deal, avg cycle),
 *                         3 (revenue trend), 5 (highlights)
 *   ALWAYS LIVE / NOW     2 (total + weighted pipeline — a stock),
 *                         4 (pipeline by stage, counts donut)
 *   ALWAYS FISCAL YTD     2 (quota attainment, coverage ratio)
 *   ALWAYS LAST 24h       6 (ops strip)
 *
 * Item 4 stays range-independent on purpose, and not only because
 * `pipelineByStageRunner` is a current-state snapshot: the Executive
 * dashboard sums the same runner for its Total Pipeline figure. Date-
 * filtering it here would silently desync the two dashboards on the
 * one number they are most often compared on.
 *
 * The consequence is that Win Rate (deals closed in the window) and
 * the counts donut (every deal ever, by stage) legitimately disagree.
 * Every tile and chart header therefore states its own window, so the
 * disagreement reads as two questions rather than one broken answer.
 */
export async function AdminHome({
  tenantId,
  tenantName,
  userId,
  view,
  range,
}: {
  tenantId: string;
  tenantName: string;
  userId: string;
  view: { mode: 'team' } | { mode: 'rep'; userId: string };
  range: DashboardRange;
}) {
  // Org-wide by default; a selected rep rescopes every deal-derived
  // surface on the page (KPIs, trend, funnel, highlights).
  const ownerId = view.mode === 'rep' ? view.userId : null;
  const ownerScope: OwnerScope =
    view.mode === 'rep' ? { type: 'user', userId: view.userId } : { type: 'all' };

  const settings = await getOrgSettings(tenantId);
  const probabilities = resolveStageProbabilities(settings.stageProbabilities);

  const [
    user,
    overview,
    pipeline,
    trend,
    kpis,
    highlights,
    workflowStats,
    aiStats,
    emailStats,
    inbox,
    recs,
    risks,
    teammates,
    savedChartView,
    savedStageConversionView,
    savedStageDonutView,
  ] = await Promise.all([
    currentUser(),
    getDashboardOverview(tenantId),
    pipelineByStageRunner(
      tenantId,
      {
        // Snapshot report — the runner ignores `range` by design. Passed
        // through so the call stays honest if that ever changes.
        range: (range.preset === 'custom'
          ? 'last_90d'
          : range.preset) as DateRangePreset,
        owner: ownerScope,
      },
      { currentUserId: userId },
    ),
    getRevenueTrend(tenantId, { days: range.days, ownerId }),
    getDashboardKpis(tenantId, {
      range,
      ownerId,
      probabilities,
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
    }),
    getDealHighlights(tenantId, { range, ownerId }),
    getWorkflowStats(tenantId, 24),
    getAiInvocationStats(tenantId, 24),
    getEmailDeliveryStats(tenantId, 24),
    getInboxCounts(tenantId),
    getRecommendationInsight(tenantId, userId),
    getRiskFlagInsight(tenantId, userId),
    listTeammates(tenantId, tenantName),
    readRevenueTrendView({ tenantId, userId }),
    readStageConversionView({ tenantId, userId }),
    readStageDonutView({ tenantId, userId }),
  ]);

  const focusedRep =
    view.mode === 'rep'
      ? (teammates.find((t) => t.id === view.userId) ?? null)
      : null;
  const scopeLabel =
    view.mode === 'rep' ? (focusedRep?.displayName ?? 'Selected rep') : null;

  const ownerNames = Object.fromEntries(
    teammates.map((t) => [t.id, t.displayName]),
  );

  const recsCount = recs.content?.recommendations.length ?? 0;
  const risksCount = risks.content?.flags.length ?? 0;

  const opsChecks = buildOpsChecks({
    workflowStats,
    aiStats,
    emailStats,
    inbox,
  });

  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <Greeting
        firstName={user?.firstName}
        tenantName={tenantName}
        personaLabel="Administrator"
        className="mb-3"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RepFilter teammates={teammates} value={view} />
        <DashboardRangeFilter range={range} />
        {/* Record counts don't belong in the KPI strip (no meaningful
            period delta), but they're still worth a glance. */}
        <span className="ml-auto hidden flex-wrap items-center gap-x-3 text-[11px] text-slate-500 sm:flex dark:text-[#A1A1AA]">
          <CountChip label="companies" value={overview.companies} />
          <CountChip label="contacts" value={overview.contacts} />
          <CountChip label="active deals" value={overview.dealsActive} />
        </span>
      </div>

      <KpiStrip
        kpis={kpis}
        currency={settings}
        range={range}
        fiscalYearStartMonth={settings.fiscalYearStartMonth}
      />

      <div className="mt-4">
        <RevenueTrendChart
          data={trend}
          currency={settings}
          title={
            scopeLabel ? `${scopeLabel} · revenue trend` : 'Organization revenue trend'
          }
          subtitle={`${range.label} · weekly buckets · ${tenantName}`}
          initialConfig={savedChartView?.config ?? null}
          initialTitleOverride={savedChartView?.title ?? null}
          persona="admin"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <StageConversionBars
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-2"
          title={
            scopeLabel
              ? `${scopeLabel} pipeline by stage — live snapshot`
              : 'Organization pipeline by stage — live snapshot'
          }
          subtitle="Every deal open right now, all time · does not follow the date filter above"
          stageProbabilities={probabilities}
          initialConfig={savedStageConversionView?.config ?? null}
          initialTitleOverride={savedStageConversionView?.title ?? null}
          persona="admin"
        />
        <StageDonut
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-1"
          title={
            scopeLabel
              ? `${scopeLabel} — deal counts, all time`
              : 'Organization-wide — deal counts, all time'
          }
          subtitle={
            scopeLabel
              ? 'Every deal on record by stage · does not follow the date filter'
              : 'Every deal on record by stage, all owners · does not follow the date filter'
          }
          initialConfig={savedStageDonutView?.config ?? null}
          initialTitleOverride={savedStageDonutView?.title ?? null}
          persona="admin"
        />
      </div>

      <div className="mt-4">
        <DealHighlightsCard
          highlights={highlights}
          ownerNames={ownerNames}
          rangeLabel={range.label}
          viewAllHrefs={buildHighlightHrefs(ownerId, highlights.atRisk.idleDays, highlights.closingSoon.lookAheadDays)}
        />
      </div>

      <div className="mt-4">
        <OpsStatusStrip checks={opsChecks} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <AISignalsCard recsCount={recsCount} risksCount={risksCount} aiStats={aiStats} />
        <AdminQuickLinks />
      </div>
    </main>
  );
}

/* ============================================================ */

/**
 * "View all →" destinations, built from the canonical deals filter
 * contract (`lib/deals/filters.ts`) so each link really does land on
 * the same set the section is showing.
 *
 * `progressed` has no equivalent deals-list filter — stage moves live
 * in the activity stream, so it points there rather than at a
 * mis-filtered deals view.
 */
function buildHighlightHrefs(
  ownerId: string | null,
  idleDays: number,
  lookAheadDays: number,
) {
  const owner = ownerId ? { ownerIds: [ownerId] } : {};
  const deals = (qs: URLSearchParams) => {
    const s = qs.toString();
    return s ? `/dashboard/deals?${s}` : '/dashboard/deals';
  };
  const today = new Date();
  const horizon = new Date(today.getTime() + lookAheadDays * 86_400_000);

  return {
    bigWins: deals(dealFiltersToSearchParams({ ...owner, stages: ['won'] })),
    // Activity feed is the only surface that lists stage transitions.
    progressed: '/dashboard/activity',
    // Deals list is ordered created_at DESC by default — newest first.
    newDeals: deals(dealFiltersToSearchParams({ ...owner })),
    atRisk: deals(
      dealFiltersToSearchParams({ ...owner, stale: true, staleDays: idleDays }),
    ),
    closingSoon: deals(
      dealFiltersToSearchParams({
        ...owner,
        expectedCloseFrom: isoDay(today),
        expectedCloseTo: isoDay(horizon),
      }),
    ),
  };
}

function CountChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-mono font-semibold tabular-nums text-slate-700 dark:text-[#FAFAFA]">
        {value.toLocaleString()}
      </span>
      {label}
    </span>
  );
}

/* ============================================================ */
/* AI signals card                                               */
/* ============================================================ */

function AISignalsCard({
  recsCount,
  risksCount,
  aiStats,
}: {
  recsCount: number;
  risksCount: number;
  aiStats: { totalCalls: number; totalTokens: number };
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Sparkles className="h-3 w-3" aria-hidden />
            Intelligence
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            AI signals
          </h2>
        </div>
        <Link
          href="/dashboard/intelligence"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Open intelligence <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SignalChip label="Recommendations" value={recsCount} />
        <SignalChip label="Risk flags" value={risksCount} tone="warning" />
        <SignalChip label="AI calls · 24h" value={aiStats.totalCalls} />
        <SignalChip
          label="Tokens · 24h"
          value={aiStats.totalTokens}
          format={compactNumber}
        />
      </div>
    </section>
  );
}

function SignalChip({
  label,
  value,
  tone = 'neutral',
  format,
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'warning';
  format?: (n: number) => string;
}) {
  const valueClass = {
    neutral: 'text-slate-900 dark:text-[#FAFAFA]',
    warning: 'text-amber-700 dark:text-amber-300',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-[#1F1F1F]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className={cn('mt-1 font-mono text-lg font-semibold tabular-nums', valueClass)}>
        {format ? format(value) : value.toLocaleString()}
      </div>
    </div>
  );
}

function compactNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/* ============================================================ */
/* Admin quick links                                             */
/* ============================================================ */

function AdminQuickLinks() {
  const links = [
    {
      href: '/dashboard/command-center',
      label: 'Command Center',
      sub: 'Operational intelligence at a glance',
      icon: Radar,
    },
    {
      href: '/dashboard/ops',
      label: 'Operations',
      sub: 'Workflow, AI, mail provider health',
      icon: Gauge,
    },
    {
      href: '/dashboard/workflows',
      label: 'Workflows',
      sub: 'Run history & retry triage',
      icon: WorkflowIcon,
    },
    {
      href: '/dashboard/settings',
      label: 'Settings',
      sub: 'Org-wide controls',
      icon: Cog,
    },
  ];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="mb-3 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
        Admin shortcuts
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="group flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-[#1F1F1F] dark:hover:border-indigo-500/40 dark:hover:bg-indigo-500/10"
          >
            <l.icon
              className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-300"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                {l.label}
              </div>
              <div className="text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                {l.sub}
              </div>
            </div>
            <ChevronRight
              className="h-3 w-3 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500 dark:text-[#3F3F46]"
              aria-hidden
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
