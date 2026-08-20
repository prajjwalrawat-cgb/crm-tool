import { currentUser } from '@/lib/auth/server';
import {
  ArrowRight,
  ChevronRight,
  Inbox,
  Mail,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-react';
import Link from 'next/link';

import {
  readRevenueTrendView,
  readStageConversionView,
  readStageDonutView,
} from '@/lib/chart-studio/queries';
import { getInboxCounts } from '@/lib/communications/threads/queries';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
} from '@/lib/currency/format';
import {
  getPipelineCreatedTrend,
  getRevenueTrend,
  getStaleDeals,
} from '@/lib/dashboard/queries';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { getRecommendationInsight } from '@/lib/intelligence/runner';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { getTopPredictionsForTenant } from '@/lib/predictions/runner';
import { dealVelocityRunner } from '@/lib/reports/queries/deal-velocity';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import { repPerformanceRunner } from '@/lib/reports/queries/rep-performance';
import { revenueForecastRunner } from '@/lib/reports/queries/revenue-forecast';
import type { OwnerScope } from '@/lib/reports/types';
import { listTeammates } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { StaleDealsCard } from '../intel-widgets';
import { RevenueTrendChart } from '../revenue-trend-chart';
import { StageConversionBars } from '../stage-conversion-bars';
import { StageDonut } from '../stage-donut';

import { Greeting } from './greeting';
import { RepFilter } from './rep-filter';

/**
 * Manager Home — people + performance visibility.
 *
 * Hero: revenue funnel scoped to either the WHOLE team (default) or a
 * specific rep (?view=rep:<userId>). The scope is reflected back in
 * the leaderboard highlight and the funnel header.
 *
 * Composition:
 *   - Revenue funnel (team or one rep)
 *   - Stage donut (deal-count distribution)
 *   - Rep leaderboard with click-to-drilldown
 *   - Forecast band (next 90d)
 *   - Communication responsiveness (top reps by emails)
 *   - Stalled team deals
 *   - AI coaching recommendations (top 3)
 *
 * The team-vs-rep toggle is URL-param driven (no client state). Each
 * leaderboard row is a link to ?view=rep:<id>; the "Team view" pill
 * links back to ?view=team. This is SSR-safe and lets the user share
 * a "look at Priya's pipeline" URL with a coworker.
 */
export async function ManagerHome({
  tenantId,
  tenantName,
  userId,
  view,
}: {
  tenantId: string;
  tenantName: string;
  userId: string;
  view: { mode: 'team' } | { mode: 'rep'; userId: string };
}) {
  const ownerScope: OwnerScope =
    view.mode === 'rep' ? { type: 'user', userId: view.userId } : { type: 'all' };

  const [
    user,
    settings,
    pipeline,
    reps,
    forecast,
    inbox,
    stale,
    recs,
    teammates,
    velocity,
    predictions,
    pipelineTrend,
    revenueTrend,
    savedChartView,
    savedStageConversionView,
    savedStageDonutView,
  ] = await Promise.all([
    currentUser(),
    getOrgSettings(tenantId),
    pipelineByStageRunner(
      tenantId,
      { range: 'last_90d', owner: ownerScope },
      { currentUserId: userId },
    ),
    repPerformanceRunner(
      tenantId,
      { range: 'last_90d', owner: { type: 'all' } },
      { currentUserId: userId },
    ),
    revenueForecastRunner(
      tenantId,
      { range: 'last_90d' },
      { currentUserId: userId },
    ),
    getInboxCounts(tenantId),
    getStaleDeals(tenantId, { staleDays: 14, limit: 6 }),
    getRecommendationInsight(tenantId, userId),
    listTeammates(tenantId, tenantName),
    dealVelocityRunner(
      tenantId,
      { range: 'last_90d', owner: { type: 'all' } },
      { currentUserId: userId },
    ),
    getTopPredictionsForTenant(tenantId, { limit: 30 }),
    getPipelineCreatedTrend(tenantId, 14),
    getRevenueTrend(tenantId, {
      days: 90,
      // ?view=rep:<id> scopes the trend to that rep; ?view=team (default)
      // leaves it whole-team.
      ownerId: view.mode === 'rep' ? view.userId : null,
    }),
    readRevenueTrendView({ tenantId, userId }),
    readStageConversionView({ tenantId, userId }),
    readStageDonutView({ tenantId, userId }),
  ]);

  const money = (m: number) =>
    settings.compactNumbers
      ? formatCompactTenantCurrency(m, settings)
      : formatTenantCurrency(m, settings);

  // Same probabilities the board weights columns with, so "% close" on
  // the stage chart never contradicts the weighted-pipeline figures.
  const stageProbabilities = resolveStageProbabilities(
    settings.stageProbabilities,
  );

  const focusedRep =
    view.mode === 'rep'
      ? teammates.find((t) => t.id === view.userId) ?? null
      : null;

  // For the funnel header label
  const scopeLabel =
    view.mode === 'rep'
      ? focusedRep?.displayName ?? 'Selected rep'
      : 'Whole team';

  const teamRevenue = reps.extras?.totalRevenueMinor ?? 0;
  const teamWonCount = reps.rows.reduce((s, r) => s + r.wonCount, 0);
  const teamLostCount = reps.rows.reduce((s, r) => s + r.lostCount, 0);
  const teamWinRate =
    teamWonCount + teamLostCount > 0
      ? teamWonCount / (teamWonCount + teamLostCount)
      : 0;

  // Total team pipeline = sum of forward (open) stage revenue.
  const teamPipelineMinor = pipeline.rows
    .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
    .reduce((s, r) => s + r.totalAmountMinor, 0);

  // Active reps = reps who recorded any activity OR closed a deal in window.
  const activeReps = reps.rows.filter(
    (r) => r.wonCount + r.lostCount + r.activityCount > 0,
  ).length;

  // At-risk deals = predictions where stale_risk > 0.6 OR comm_risk > 0.6
  // OR deal_momentum < 0.4. Predictions are per-deal; we dedupe by entityId
  // so a deal flagged on two dimensions only counts once.
  const atRiskIds = new Set<string>();
  for (const p of predictions) {
    if (
      (p.kind === 'stale_risk' && p.value > 0.6) ||
      (p.kind === 'comm_risk' && p.value > 0.6) ||
      (p.kind === 'deal_momentum' && p.value < 0.4)
    ) {
      atRiskIds.add(p.entityId);
    }
  }
  const atRiskCount = atRiskIds.size;
  const avgDaysToClose = velocity.extras?.avgDaysToClose ?? 0;

  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <Greeting
        firstName={user?.firstName}
        tenantName={tenantName}
        personaLabel="Manager"
        className="mb-3"
      />

      <div className="flex flex-wrap items-center gap-2">
        <RepFilter
          teammates={teammates.map((t) => ({ id: t.id, displayName: t.displayName }))}
          value={view}
        />
        <ViewToggle view={view} focusedRepName={focusedRep?.displayName ?? null} />
      </div>

      {/* KPI strip — team-level numbers always (not affected by rep toggle) */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <KpiTile
          label="Team pipeline"
          value={money(teamPipelineMinor)}
          sub="open stages"
          tint="indigo"
        />
        <KpiTile
          label="Weighted forecast"
          value={money(forecast.extras?.totalLikelyMinor ?? 0)}
          sub={`${forecast.extras?.totalDeals ?? 0} open deals`}
          tint="violet"
        />
        <KpiTile
          label="Team revenue · 90d"
          value={money(teamRevenue)}
          sub={`${teamWonCount} won`}
          tint="emerald"
        />
        <KpiTile
          label="Conversion"
          value={`${Math.round(teamWinRate * 100)}%`}
          sub={`${teamLostCount} lost`}
          tint="indigo"
        />
        <KpiTile
          label="Active reps"
          value={`${activeReps}`}
          sub={`of ${reps.rows.length}`}
          tint="slate"
        />
        <KpiTile
          label="Avg cycle"
          value={avgDaysToClose > 0 ? `${avgDaysToClose}d` : '—'}
          sub="to close"
          tint="slate"
        />
        <KpiTile
          label="Stalled"
          value={String(stale.length)}
          sub="14d+ idle"
          tint={stale.length > 0 ? 'rose' : 'slate'}
        />
        <KpiTile
          label="At risk"
          value={String(atRiskCount)}
          sub="AI-flagged"
          tint={atRiskCount > 0 ? 'rose' : 'slate'}
        />
      </div>

      {/* Hero: revenue trend area chart, scoped to selected view.
          Currency CONTEXT (not a formatter function) crosses the RSC
          boundary cleanly — see RevenueTrendChart for why. */}
      <div className="mt-4">
        <RevenueTrendChart
          data={revenueTrend}
          currency={settings}
          title={view.mode === 'rep' ? `${scopeLabel} · revenue trend` : 'Team revenue trend'}
          subtitle={`Last 90 days · weekly buckets · ${tenantName}`}
          initialConfig={savedChartView?.config ?? null}
          initialTitleOverride={savedChartView?.title ?? null}
          persona="manager"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <StageConversionBars
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-2"
          title={
            view.mode === 'rep'
              ? `${scopeLabel} pipeline by stage — live snapshot`
              : 'Team pipeline by stage — live snapshot'
          }
          subtitle="Every deal open right now, all time · not the 90-day window above"
          stageProbabilities={stageProbabilities}
          initialConfig={savedStageConversionView?.config ?? null}
          initialTitleOverride={savedStageConversionView?.title ?? null}
          persona="manager"
        />
        <StageDonut
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-1"
          title={
            view.mode === 'rep'
              ? `${scopeLabel} — deal counts, all time`
              : 'Team — deal counts, all time'
          }
          subtitle="Every deal on record by stage · not the 90-day window above"
          initialConfig={savedStageDonutView?.config ?? null}
          initialTitleOverride={savedStageDonutView?.title ?? null}
          persona="manager"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <PipelineTrendStrip trend={pipelineTrend} className="lg:col-span-1" />
        <RepLeaderboard
          rows={reps.rows.slice(0, 6)}
          formatCurrency={money}
          focusedUserId={view.mode === 'rep' ? view.userId : null}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <StaleDealsCard rows={stale} staleDays={14} />
        <CommunicationResponsivenessCard
          reps={reps.rows.slice(0, 5)}
          inbox={inbox}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <ForecastCard
          monthly={forecast.rows.slice(0, 6)}
          formatCurrency={money}
        />
        <AICoachingCard
          recs={recs.content?.recommendations.slice(0, 5) ?? []}
        />
      </div>
    </main>
  );
}

/* ============================================================ */
/* View toggle                                                   */
/* ============================================================ */

function ViewToggle({
  view,
  focusedRepName,
}: {
  view: { mode: 'team' } | { mode: 'rep'; userId: string };
  focusedRepName: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href="/dashboard?view=team"
        aria-current={view.mode === 'team' ? 'page' : undefined}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition',
          view.mode === 'team'
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300'
            : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#A1A1AA] dark:hover:bg-[#181818]',
        )}
      >
        <Users className="h-3.5 w-3.5" aria-hidden />
        Team view
      </Link>
      {view.mode === 'rep' && focusedRepName ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[12px] font-medium text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Trophy className="h-3.5 w-3.5" aria-hidden />
          {focusedRepName}
        </span>
      ) : null}
    </div>
  );
}

/* ============================================================ */
/* KPI tile                                                      */
/* ============================================================ */

function KpiTile({
  label,
  value,
  sub,
  tint,
}: {
  label: string;
  value: string;
  sub: string;
  tint: 'indigo' | 'emerald' | 'violet' | 'rose' | 'slate';
}) {
  const tintBar = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    violet: 'bg-violet-500',
    rose: 'bg-rose-500',
    slate: 'bg-slate-300 dark:bg-slate-700',
  }[tint];
  // `@container` enables container queries so the value font scales
  // with the card's own width (cqi = 1% of container inline size).
  // 8-card xl grid can squeeze each card down to ~140px; clamp keeps
  // long currency strings like ₹987,654,321 inside the bounds without
  // truncation.
  return (
    <div className="@container relative overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <span className={cn('absolute inset-y-0 left-0 w-0.5', tintBar)} aria-hidden />
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className="mt-1 whitespace-nowrap font-mono text-[clamp(12px,7cqi,17px)] font-semibold tabular-nums tracking-tight text-slate-900 dark:text-[#FAFAFA]">
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">{sub}</div>
    </div>
  );
}

/* ============================================================ */
/* Rep leaderboard                                               */
/* ============================================================ */

function RepLeaderboard({
  rows,
  formatCurrency,
  focusedUserId,
}: {
  rows: Array<{
    ownerId: string;
    ownerDisplayName: string;
    wonCount: number;
    lostCount: number;
    revenueMinor: number;
    activityCount: number;
    winRate: number;
  }>;
  formatCurrency: (m: number) => string;
  focusedUserId: string | null;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A] lg:col-span-2">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <Trophy className="h-3 w-3" aria-hidden />
            Leaderboard
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Reps · last 90 days
          </h2>
        </div>
        <Link
          href="/dashboard/reports/rep-performance"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Full report <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-6 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No rep activity in the last 90 days.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
          {rows.map((r, i) => {
            const isFocused = r.ownerId === focusedUserId;
            return (
              <li key={r.ownerId}>
                <Link
                  href={`/dashboard?view=rep:${encodeURIComponent(r.ownerId)}`}
                  className={cn(
                    'flex items-center gap-3 px-1 py-2 transition-colors',
                    isFocused
                      ? 'bg-indigo-50/60 dark:bg-indigo-500/10'
                      : 'hover:bg-slate-50/70 dark:hover:bg-[#181818]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold tabular-nums',
                      i === 0
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200'
                        : i === 1
                          ? 'bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200'
                          : i === 2
                            ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-200'
                            : 'bg-slate-50 text-slate-500 dark:bg-[#181818] dark:text-[#A1A1AA]',
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                      {r.ownerDisplayName}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                      <span>
                        <span className="font-semibold text-slate-700 dark:text-[#FAFAFA]">
                          {r.wonCount}
                        </span>{' '}
                        won
                      </span>
                      <span>
                        <span className="font-semibold text-slate-700 dark:text-[#FAFAFA]">
                          {Math.round(r.winRate * 100)}%
                        </span>{' '}
                        win
                      </span>
                      <span>
                        <span className="font-semibold text-slate-700 dark:text-[#FAFAFA]">
                          {r.activityCount}
                        </span>{' '}
                        actions
                      </span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="font-mono text-[13px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                      {formatCurrency(r.revenueMinor)}
                    </div>
                    <div className="text-[10px] text-slate-400 dark:text-[#71717A]">
                      revenue
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* Communication responsiveness                                  */
/* ============================================================ */

function CommunicationResponsivenessCard({
  reps,
  inbox,
}: {
  reps: Array<{
    ownerId: string;
    ownerDisplayName: string;
    emailCount: number;
    activityCount: number;
  }>;
  inbox: { active: number; unread: number; failed: number };
}) {
  const maxEmails = Math.max(1, ...reps.map((r) => r.emailCount));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
            <Mail className="h-3 w-3" aria-hidden />
            Comms
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Team responsiveness · 90d
          </h2>
        </div>
        <Link
          href="/dashboard/communications"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Open inbox <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      <div className="mb-3 grid grid-cols-3 gap-2 text-[11px]">
        <MiniStat label="Active threads" value={inbox.active} />
        <MiniStat label="Unread" value={inbox.unread} tone={inbox.unread > 0 ? 'warning' : 'neutral'} />
        <MiniStat label="Failed" value={inbox.failed} tone={inbox.failed > 0 ? 'danger' : 'neutral'} />
      </div>

      {reps.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-5 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No rep email activity yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {reps.map((r) => {
            const widthPct = Math.max(2, (r.emailCount / maxEmails) * 100);
            return (
              <li key={r.ownerId} className="flex items-center gap-2 text-[11.5px]">
                <span className="w-24 flex-shrink-0 truncate text-slate-700 dark:text-[#FAFAFA]">
                  {r.ownerDisplayName}
                </span>
                <span className="relative h-3 flex-1 rounded-full bg-slate-100 dark:bg-[#181818]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-sky-400 dark:bg-sky-500/60"
                    style={{ width: `${widthPct}%` }}
                  />
                </span>
                <span className="w-14 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-600 dark:text-[#A1A1AA]">
                  {r.emailCount}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* Pipeline trend strip                                          */
/* ============================================================ */

function PipelineTrendStrip({
  trend,
  className,
}: {
  trend: Array<{ day: string; n: number }>;
  className?: string;
}) {
  // 14 buckets, dense fill so missing days render at zero.
  const today = new Date();
  const days: Array<{ iso: string; n: number }> = [];
  const byDay = new Map(trend.map((t) => [t.day, t.n] as const));
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, n: byDay.get(iso) ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.n));
  const total = days.reduce((s, d) => s + d.n, 0);

  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-slate-500 dark:text-[#A1A1AA]">
            New deals · last 14d
          </div>
          <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
            {total}
          </div>
        </div>
        <svg
          viewBox="0 0 140 32"
          className="h-8 w-44 sm:w-60"
          aria-hidden
          preserveAspectRatio="none"
        >
          {days.map((d, i) => {
            const w = 140 / days.length;
            const h = (d.n / max) * 28;
            return (
              <rect
                key={d.iso}
                x={i * w + 1}
                y={32 - h}
                width={w - 2}
                height={Math.max(1, h)}
                rx="1"
                ry="1"
                className="fill-indigo-200 dark:fill-indigo-500/40"
              >
                <title>{`${d.iso}: ${d.n} new`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'warning' | 'danger';
}) {
  const valueClass = {
    neutral: 'text-slate-900 dark:text-[#FAFAFA]',
    warning: 'text-amber-700 dark:text-amber-300',
    danger: 'text-rose-700 dark:text-rose-300',
  }[tone];
  return (
    <div className="rounded-md border border-slate-200 px-2 py-1.5 dark:border-[#1F1F1F]">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className={cn('font-mono text-sm font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Forecast card                                                 */
/* ============================================================ */

function ForecastCard({
  monthly,
  formatCurrency,
}: {
  monthly: Array<{
    monthIso: string;
    monthLabel: string;
    likelyMinor: number;
    bestCaseMinor: number;
    worstCaseMinor: number;
    dealCount: number;
  }>;
  formatCurrency: (m: number) => string;
}) {
  const max = Math.max(1, ...monthly.map((m) => m.bestCaseMinor));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
            <ArrowRight className="h-3 w-3" aria-hidden />
            Forecast
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Expected revenue by month
          </h2>
        </div>
        <Link
          href="/dashboard/reports/revenue-forecast"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Full forecast <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      {monthly.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-5 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No open deals with expected-close dates in the forecast window.
        </p>
      ) : (
        <ul className="space-y-2">
          {monthly.map((m) => {
            const likelyPct = (m.likelyMinor / max) * 100;
            const bestPct = (m.bestCaseMinor / max) * 100;
            return (
              <li key={m.monthIso} className="flex items-center gap-3 text-[11.5px]">
                <span className="w-20 flex-shrink-0 text-slate-700 dark:text-[#FAFAFA]">
                  {m.monthLabel}
                </span>
                <span className="relative h-4 flex-1 rounded-md bg-slate-100 dark:bg-[#181818]">
                  <span
                    className="absolute inset-y-0 left-0 rounded-md bg-violet-200 dark:bg-violet-500/30"
                    style={{ width: `${bestPct}%` }}
                    aria-hidden
                  />
                  <span
                    className="absolute inset-y-0 left-0 rounded-md bg-violet-500 dark:bg-violet-400"
                    style={{ width: `${likelyPct}%` }}
                    aria-hidden
                  />
                </span>
                <span className="w-24 flex-shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-700 dark:text-[#FAFAFA]">
                  {formatCurrency(m.likelyMinor)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ============================================================ */
/* AI coaching                                                   */
/* ============================================================ */

function AICoachingCard({
  recs,
}: {
  recs: Array<{
    title: string;
    rationale: string;
    actionKind: string;
    entity: { id: string; type: string; name: string };
  }>;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Sparkles className="h-3 w-3" aria-hidden />
            AI coaching
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Recommended actions
          </h2>
        </div>
        <Link
          href="/dashboard/intelligence"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Open intelligence <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      {recs.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-5 text-center text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
          No fresh recommendations. The AI layer refreshes on data change.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {recs.map((rec, i) => {
            const href =
              rec.entity.type === 'deal'
                ? `/dashboard/deals/${rec.entity.id}`
                : rec.entity.type === 'contact'
                  ? `/dashboard/contacts/${rec.entity.id}`
                  : rec.entity.type === 'company'
                    ? `/dashboard/companies/${rec.entity.id}`
                    : '/dashboard/intelligence';
            return (
              <li
                key={i}
                className="flex items-start gap-2 rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[12px] dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
              >
                <span
                  className="mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full bg-indigo-500"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900 dark:text-[#FAFAFA]">
                    <Link
                      href={href}
                      className="hover:text-indigo-600 dark:hover:text-indigo-300"
                    >
                      {rec.entity.name} — {rec.title}
                    </Link>
                  </div>
                  <div className="mt-0.5 line-clamp-1 text-[10.5px] text-slate-500 dark:text-[#A1A1AA]">
                    {rec.rationale}
                  </div>
                </div>
                <Inbox className="h-3 w-3 flex-shrink-0 text-slate-300 dark:text-[#3F3F46]" aria-hidden />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
