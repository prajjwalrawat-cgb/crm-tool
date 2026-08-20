import { Sparkles } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { readRevenueTrendView } from '@/lib/chart-studio/queries';
import { getAIMode } from '@/lib/ai/config';
import { formatCompactTenantCurrency, formatTenantCurrency } from '@/lib/currency/format';
import { formatDate, formatNumber } from '@/lib/dates/format';
import { getRevenueTrend } from '@/lib/dashboard/queries';
import {
  resolveDashboardRange,
  type DashboardRange,
} from '@/lib/dashboard/range';
import { rankAttentionQueue } from '@/lib/dashboard/attention-score';
import { parseViewScope, scopeOwnerId } from '@/lib/dashboard/view-scope';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import {
  getDailyExecInsight,
  getRecommendationInsight,
} from '@/lib/intelligence/runner';
import { dealVelocityRunner } from '@/lib/reports/queries/deal-velocity';
import { emailEngagementRunner } from '@/lib/reports/queries/email-engagement';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import { repPerformanceRunner } from '@/lib/reports/queries/rep-performance';
import { revenueForecastRunner } from '@/lib/reports/queries/revenue-forecast';
import { staleDealsRunner } from '@/lib/reports/queries/stale-deals';
import { winLossRateRunner } from '@/lib/reports/queries/win-loss-rate';
import type { DateRangePreset, OwnerScope } from '@/lib/reports/types';
import { listTeammates } from '@/lib/teammates/queries';

import {
  LiveDailyExecCard,
  LiveRecommendationsCard,
} from '../intelligence/_components/live-ai-card';

import { DashboardRangeFilter } from '../_components/dashboard-range-filter';
import { RepFilter } from '../_components/home/rep-filter';
import { MetricCard } from '../_components/metric-card';
import { RevenueTrendChart } from '../_components/revenue-trend-chart';
import {
  AttentionItem,
  AttentionList,
  DashboardGrid,
  DashboardGridCell,
  ExecutiveSection,
  InsightCard,
  SectionLink,
  ValueNotSet,
} from './_components/executive-primitives';

export const metadata = {
  title: 'Executive Dashboard',
};

/**
 * Executive view — one screen that answers "how is the business doing
 * right now?". Composes six existing report runners in parallel, then
 * arranges the highlights into five themed sections.
 *
 * Why reuse the runners (instead of writing a new "executive query"):
 * the runners already enforce tenant isolation, owner scoping, and
 * indexing; duplicating their SQL into a single mega-query would
 * trade ~6 small index hits for one giant fan-out that's harder to
 * cache and debug. Parallel Promise.all keeps the wall time bounded
 * by the slowest runner.
 *
 * FILTERS. One `?range=` + `?view=` pair drives the whole page, read
 * through the same `resolveDashboardRange` / `parseViewScope` the
 * main Dashboard uses. Every runner below is handed the resolved
 * window and owner scope; none carries its own hardcoded range any
 * more. A URL is portable between the two dashboards and means the
 * same thing on both.
 *
 * WINDOWS. What the shared filter can and cannot move:
 *
 *   winLossRateRunner      follows ?range= (close date)
 *   repPerformanceRunner   follows ?range=
 *   dealVelocityRunner     follows ?range=
 *   emailEngagementRunner  follows ?range=
 *   revenue trend          follows ?range=
 *   pipelineByStageRunner  owner-scoped, but ALWAYS all-time — it is
 *                          a live snapshot and, crucially, the source
 *                          of the Total Pipeline figure the Dashboard
 *                          also shows. Date-filtering it would desync
 *                          the two views.
 *   revenueForecastRunner  always next 180 days — forward-looking by
 *                          definition; a past window has no forecast.
 *   staleDealsRunner       always every open deal, any age — a
 *                          90-day cutoff would hide the most stalled
 *                          deals, which is the opposite of the job.
 *
 * The three that cannot follow the picker say so in their subtitles
 * rather than quietly ignoring it.
 *
 * "Won revenue" in particular comes off the ALL-TIME snapshot, not the
 * 90-day window — it used to be captioned "(90d)", which was simply
 * false. Left as all-time deliberately: it is the same figure the
 * Dashboard's stage chart shows, so the two views agree.
 *
 * THE TREND CHART IS THE DASHBOARD'S, NOT A COPY. `RevenueTrendChart`
 * is imported from `../_components`, fed by the same
 * `getRevenueTrend` query and the same per-user Chart Studio view
 * (`CHART_KEY_REVENUE_TREND`). One implementation, two mount points:
 * a fix to the shaping math or the capping rule lands on both views
 * at once, and a Studio tweak a user saves on one shows up on the
 * other — which is the point of it being the same chart rather than
 * a lookalike.
 *
 * ZERO VS NO DATA. Several cards here can legitimately read zero and
 * several cannot read anything at all, and they used to look
 * identical — worse, the empty ones were styled in danger red, which
 * turned "you never configured email" into "your email is failing".
 * Cards whose source may be absent pass `emptyState` (see MetricCard)
 * and render muted guidance instead of a number. Cards where zero is
 * a real answer — no stalled deals, no active deals — keep the zero,
 * because that is genuinely the news.
 */
export default async function ExecutiveDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant, userId }) => {
    const sp = await searchParams;
    // Same resolvers, same `?range=` / `?view=` contract, same default
    // (90d, whole team) as the main Dashboard — so a window or rep
    // chosen there means the same thing if the URL is carried across.
    const range: DashboardRange = resolveDashboardRange(sp);
    const view = parseViewScope(sp.view);
    const ownerId = scopeOwnerId(view);
    const ownerScope: OwnerScope = ownerId
      ? { type: 'user', userId: ownerId }
      : { type: 'all' };
    // The report runners take a preset, not an arbitrary window. A
    // custom range has no preset to hand them, so they fall back to the
    // 90-day default — matching what AdminHome does, and called out in
    // the header so the page never silently disagrees with its picker.
    const runnerRange: DateRangePreset = (
      range.preset === 'custom' ? 'last_90d' : range.preset
    ) as DateRangePreset;
    const customRangeUnsupported = range.preset === 'custom';
    const filter = { range: runnerRange, owner: ownerScope } as const;
    const ctx = { currentUserId: userId };

    const today = new Date().toISOString().slice(0, 10);
    const aiMode = getAIMode();
    const settings = await getOrgSettings(tenant.id);
    const money = (amountMinor: number) =>
      settings.compactNumbers
        ? formatCompactTenantCurrency(amountMinor, settings)
        : formatTenantCurrency(amountMinor, settings);
    const [
      pipeline,
      winLoss,
      reps,
      velocity,
      forecast,
      email,
      stale,
      dailyInsight,
      recsInsight,
      revenueTrend,
      savedTrendView,
      teammates,
    ] = await Promise.all([
      pipelineByStageRunner(tenant.id, filter, ctx),
      winLossRateRunner(tenant.id, filter, ctx),
      repPerformanceRunner(tenant.id, filter, ctx),
      dealVelocityRunner(tenant.id, filter, ctx),
      // Forward-looking by definition — the picker's window cannot
      // apply, but the owner scope must.
      revenueForecastRunner(
        tenant.id,
        { range: 'next_180d' as unknown as 'last_90d', owner: ownerScope },
        ctx,
      ),
      emailEngagementRunner(tenant.id, filter, ctx),
      staleDealsRunner(tenant.id, filter, ctx),
      getDailyExecInsight(tenant.id, userId, today),
      getRecommendationInsight(tenant.id, userId),
      getRevenueTrend(tenant.id, { days: range.days, ownerId }),
      readRevenueTrendView({ tenantId: tenant.id, userId }),
      listTeammates(tenant.id, tenant.name),
    ]);

    const totalPipelineMinor = pipeline.rows
      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
      .reduce((s, r) => s + r.totalAmountMinor, 0);
    const wonRevenueMinor = pipeline.rows.find((r) => r.stage === 'won')?.totalAmountMinor ?? 0;

    // A rep with nothing closed and nothing earned in the window is
    // not a low-ranking performer, they are absent from the data.
    // Padding the leaderboard to three rows with zero-activity reps
    // made the board look like a losing team rather than a quiet one.
    const activeReps = reps.rows.filter(
      (r) => r.wonCount > 0 || r.lostCount > 0 || r.revenueMinor > 0,
    );
    const topRep = activeReps.slice(0, 3);
    const dormantRepCount = reps.rows.length - activeReps.length;

    // Stages an org never uses (Hold, most commonly) held a full KPI
    // grid slot each just to display a 0. A tile is a claim that a
    // number is worth reading; "Hold: 0" in a workspace that has
    // never parked a deal is not. Occupied stages keep their tile,
    // empty ones collapse to one footnote line — still stated, so
    // nobody wonders whether the stage exists, just not at tile size.
    const openStages = pipeline.rows.filter(
      (r) => r.stage !== 'won' && r.stage !== 'lost',
    );
    const occupiedStages = openStages.filter((r) => r.count > 0);
    const emptyStages = openStages.filter((r) => r.count === 0);

    const emailConfigured = email.extras?.hasEverSent ?? false;
    const closedInWindow = winLoss.extras?.totalClosed ?? 0;
    const forecastDeals = forecast.extras?.totalDeals ?? 0;
    const wonDealCount =
      pipeline.rows.find((r) => r.stage === 'won')?.count ?? 0;
    // Ranked by composite risk, not by age. Sorting on staleness alone
    // put a ₹0 lead nobody had touched above a large negotiation that
    // had just slid backwards — see lib/dashboard/attention-score.
    // Severity still drives the row colour; it is deliberately NOT an
    // input to the score, because it is derived from the same staleness
    // signals and would double-count age.
    const attentionRows = rankAttentionQueue(stale.rows).slice(0, 6);

    const focusedRep =
      view.mode === 'rep'
        ? (teammates.find((t) => t.id === view.userId) ?? null)
        : null;
    const scopeLabel =
      view.mode === 'rep'
        ? (focusedRep?.displayName ?? 'Selected rep')
        : null;

    const generatedAt = new Date();

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Sparkles className="h-3 w-3" aria-hidden />
              Executive
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Business at a glance
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Pipeline, performance, velocity, and forecast — all rolled up into
              one screen. Sections use different windows by nature; each one
              states its own beneath the heading.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <RepFilter
                teammates={teammates}
                value={view}
                basePath="/dashboard/executive"
              />
              <DashboardRangeFilter
                range={range}
                basePath="/dashboard/executive"
              />
            </div>
            {customRangeUnsupported ? (
              <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                Custom ranges aren&apos;t supported by the report runners this
                page composes — everything below is showing the last 90 days.
                The trend chart alone honours your custom window.
              </p>
            ) : null}
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-right dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              Tenant
            </div>
            <div className="font-mono text-sm font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {tenant.name}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500 dark:text-[#A1A1AA]">
              Generated {formatDate(generatedAt)}
            </div>
          </div>
        </header>

        <div className="space-y-4">
          <ExecutiveSection
            title="Revenue"
            subtitle={`Won revenue all time · win rate ${range.label.toLowerCase()} · forecast next 180 days`}
            action={<SectionLink href="/dashboard/reports/revenue-forecast" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Won revenue"
                  value={money(wonRevenueMinor)}
                  hint={`${wonDealCount} won ${wonDealCount === 1 ? 'deal' : 'deals'} · all time`}
                  tone="success"
                  href="/dashboard/reports/win-loss-rate"
                  emptyState={
                    wonDealCount === 0
                      ? 'No deals marked Won yet. Close one and it lands here.'
                      : undefined
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Likely forecast"
                  value={money(forecast.extras?.totalLikelyMinor ?? 0)}
                  hint={`${forecastDeals} open deals · ${Math.round((forecast.extras?.avgConfidence ?? 0) * 100)}% avg confidence`}
                  tone="info"
                  href="/dashboard/reports/revenue-forecast"
                  emptyState={
                    forecastDeals === 0
                      ? 'No open deals carry a close date in the next 180 days — nothing to forecast from.'
                      : undefined
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Best case"
                  value={money(forecast.extras?.totalBestCaseMinor ?? 0)}
                  hint="If every open deal in the window closes"
                  tone="success"
                  emptyState={
                    forecastDeals === 0
                      ? 'Set expected close dates on open deals to get a best case.'
                      : undefined
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Win rate"
                  value={`${Math.round((winLoss.extras?.winRate ?? 0) * 100)}%`}
                  hint={`${closedInWindow} deals closed in ${range.label.toLowerCase()}`}
                  // Nothing closed means the rate is undefined, not 0%.
                  emptyState={
                    closedInWindow === 0
                      ? `No deals closed in ${range.label.toLowerCase()}, so there is no win rate to compute.`
                      : undefined
                  }
                  tone={
                    (winLoss.extras?.winRate ?? 0) >= 0.5
                      ? 'success'
                      : (winLoss.extras?.winRate ?? 0) >= 0.3
                        ? 'warning'
                        : 'danger'
                  }
                  href="/dashboard/reports/win-loss-rate"
                />
              </DashboardGridCell>
            </DashboardGrid>
          </ExecutiveSection>

          <RevenueTrendChart
            data={revenueTrend}
            currency={settings}
            title={scopeLabel ? `${scopeLabel} · revenue trend` : 'Revenue trend'}
            subtitle={`${range.label} · weekly buckets · ${scopeLabel ?? tenant.name}`}
            initialConfig={savedTrendView?.config ?? null}
            initialTitleOverride={savedTrendView?.title ?? null}
            persona="admin"
          />

          <ExecutiveSection
            title={scopeLabel ? `Pipeline health — ${scopeLabel}` : 'Pipeline health'}
            subtitle="Every deal open right now, all time · does not follow the date filter"
            action={<SectionLink href="/dashboard/reports/pipeline-by-stage" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={4}>
                <MetricCard
                  label="Pipeline value"
                  value={money(totalPipelineMinor)}
                  hint={`Across ${openStages.reduce((s, r) => s + r.count, 0)} active deals`}
                  tone="info"
                />
              </DashboardGridCell>
              {occupiedStages.map((row) => (
                <DashboardGridCell key={row.stage} span={4}>
                  <MetricCard
                    label={row.stageLabel}
                    value={formatNumber(row.count)}
                    hint={
                      row.totalAmountMinor > 0
                        ? `${money(row.totalAmountMinor)} in this stage`
                        : `${row.count === 1 ? 'The deal here has' : 'None of these deals have'} an amount recorded`
                    }
                    tone="neutral"
                  />
                </DashboardGridCell>
              ))}
            </DashboardGrid>
            {emptyStages.length > 0 ? (
              <p className="mt-2.5 text-[10.5px] text-slate-400 dark:text-[#71717A]">
                No open deals in{' '}
                {emptyStages.map((r) => r.stageLabel).join(', ')} — collapsed
                from the grid rather than shown as empty tiles.
              </p>
            ) : null}
          </ExecutiveSection>

          <DashboardGrid>
            <DashboardGridCell span={6}>
              <ExecutiveSection
                title="Top performers"
                subtitle={
                  dormantRepCount > 0
                    ? `Deals closed in ${range.label.toLowerCase()} · ${dormantRepCount} rep${dormantRepCount === 1 ? '' : 's'} with no closed deals omitted`
                    : `Highest revenue contributors · deals closed in ${range.label.toLowerCase()}`
                }
                action={<SectionLink href="/dashboard/reports/rep-performance" />}
              >
                <AttentionList
                  emptyMessage={`No rep closed a deal in ${range.label.toLowerCase()}.`}
                >
                  {topRep.length === 0
                    ? null
                    : topRep.map((rep, i) => (
                        <AttentionItem
                          key={rep.ownerId}
                          title={
                            <span>
                              <span className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-100 font-mono text-[9.5px] font-semibold text-slate-600">
                                {i + 1}
                              </span>
                              {rep.ownerDisplayName}
                            </span>
                          }
                          detail={`${rep.wonCount} won · ${rep.lostCount} lost · ${Math.round(rep.winRate * 100)}% win rate`}
                          meta={
                            rep.revenueMinor > 0 ? (
                              money(rep.revenueMinor)
                            ) : (
                              <ValueNotSet />
                            )
                          }
                          severity="info"
                        />
                      ))}
                </AttentionList>
              </ExecutiveSection>
            </DashboardGridCell>

            <DashboardGridCell span={6}>
              <ExecutiveSection
                title="Velocity & bottlenecks"
                subtitle={`Where deals slow down between stages · ${range.label.toLowerCase()}`}
                action={<SectionLink href="/dashboard/reports/deal-velocity" />}
              >
                <DashboardGrid cols={6}>
                  <DashboardGridCell span={6}>
                    <MetricCard
                      label="Avg days to close"
                      value={
                        velocity.extras?.dealsWithHistory
                          ? `${velocity.extras.avgDaysToClose}d`
                          : '—'
                      }
                      hint={`${velocity.extras?.dealsWithHistory ?? 0} closed deals tracked`}
                      tone="info"
                      emptyState={
                        velocity.extras?.dealsWithHistory
                          ? undefined
                          : 'No deal has closed with stage history recorded yet.'
                      }
                    />
                  </DashboardGridCell>
                  <DashboardGridCell span={3}>
                    <MetricCard
                      label="Bottleneck stage"
                      value={
                        velocity.extras?.bottleneckStage
                          ? DEAL_STAGE_LABELS[velocity.extras.bottleneckStage]
                          : '—'
                      }
                      hint="Highest avg time-in-stage"
                      tone="warning"
                      emptyState={
                        velocity.extras?.bottleneckStage
                          ? undefined
                          : 'Not enough stage movement to rank stages.'
                      }
                    />
                  </DashboardGridCell>
                  <DashboardGridCell span={3}>
                    <MetricCard
                      label="Fastest stage"
                      value={
                        velocity.extras?.fastestStage
                          ? DEAL_STAGE_LABELS[velocity.extras.fastestStage]
                          : '—'
                      }
                      hint="Lowest avg time-in-stage"
                      tone="success"
                      emptyState={
                        velocity.extras?.fastestStage
                          ? undefined
                          : 'Not enough stage movement to rank stages.'
                      }
                    />
                  </DashboardGridCell>
                </DashboardGrid>
              </ExecutiveSection>
            </DashboardGridCell>
          </DashboardGrid>

          <ExecutiveSection
            title="Operational health"
            subtitle={`Email deliverability ${range.label.toLowerCase()} · deal counts live, all time`}
            action={<SectionLink href="/dashboard/reports/email-engagement" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Emails sent"
                  value={formatNumber(email.extras?.totalSent ?? 0)}
                  hint={`${Math.round((email.extras?.successRate ?? 0) * 100)}% delivered`}
                  tone={
                    (email.extras?.successRate ?? 0) >= 0.95
                      ? 'success'
                      : (email.extras?.successRate ?? 0) >= 0.85
                        ? 'warning'
                        : 'danger'
                  }
                  // Never sent ANY mail, ever → the integration is not
                  // wired up. Sent mail before but none in this window →
                  // a real, reportable zero.
                  emptyState={
                    emailConfigured
                      ? undefined
                      : 'Connect email tracking to see deliverability.'
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Retry rate"
                  value={`${Math.round((email.extras?.retryRate ?? 0) * 100)}%`}
                  hint="Lower is better"
                  tone={
                    (email.extras?.retryRate ?? 0) <= 0.05
                      ? 'success'
                      : (email.extras?.retryRate ?? 0) <= 0.15
                        ? 'warning'
                        : 'danger'
                  }
                  emptyState={
                    emailConfigured
                      ? (email.extras?.totalAttempted ?? 0) === 0
                        ? `No mail attempted in ${range.label.toLowerCase()}.`
                        : undefined
                      : 'Connect email tracking to see deliverability.'
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Stalled deals"
                  value={formatNumber(stale.rows.filter((r) => r.severity === 'critical' || r.severity === 'stale').length)}
                  hint="Need re-engagement · any age"
                  tone="warning"
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Active deals"
                  value={formatNumber(
                    openStages.reduce((s, r) => s + r.count, 0),
                  )}
                  hint="Currently in flight · live count"
                  tone="neutral"
                />
              </DashboardGridCell>
            </DashboardGrid>
          </ExecutiveSection>

          <ExecutiveSection
            title="Attention queue"
            subtitle="Ranked by days stalled, deal value, stage regression and missing next steps · every open deal, any age"
            action={<SectionLink href="/dashboard/reports/stale-deals" />}
          >
            <AttentionList emptyMessage="Nothing stalled. Pipeline is healthy.">
              {attentionRows.length === 0
                ? null
                : attentionRows.map((row) => (
                    <AttentionItem
                      key={row.dealId}
                      title={row.name}
                      detail={
                        <>
                          <span className="font-medium text-slate-600 dark:text-[#D4D4D8]">
                            {row.attention.reason}
                          </span>
                          {' · '}
                          {DEAL_STAGE_LABELS[row.stage]}
                          {row.daysSinceStageChange != null
                            ? ` · ${row.daysSinceStageChange}d in stage`
                            : ''}
                        </>
                      }
                      meta={
                        row.amountMinor > 0 ? (
                          money(row.amountMinor)
                        ) : (
                          <ValueNotSet />
                        )
                      }
                      severity={
                        row.severity === 'critical'
                          ? 'danger'
                          : row.severity === 'stale'
                            ? 'warning'
                            : 'info'
                      }
                      href={`/dashboard/deals/${row.dealId}`}
                    />
                  ))}
            </AttentionList>
          </ExecutiveSection>

          <ExecutiveSection
            title="AI insights"
            subtitle="Daily summary and top recommendations from the intelligence layer"
            action={<SectionLink href="/dashboard/intelligence" label="Open intelligence" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={8}>
                <LiveDailyExecCard
                  tenantId={tenant.id}
                  id={today}
                  title="Daily executive summary"
                  subtitle={`Snapshot for ${today}`}
                  tone="info"
                  summaryId={null}
                  hideFeedback
                  initial={dailyInsight.content}
                  initialState={dailyInsight.state}
                  initialGeneratedAt={dailyInsight.generatedAt?.toISOString() ?? null}
                  modeOverride={
                    aiMode === 'disabled'
                      ? 'disabled'
                      : aiMode === 'mock'
                        ? 'mock'
                        : undefined
                  }
                />
              </DashboardGridCell>
              <DashboardGridCell span={4}>
                <LiveRecommendationsCard
                  tenantId={tenant.id}
                  title="Top recommendations"
                  subtitle="Suggested next actions"
                  tone="success"
                  summaryId={null}
                  hideFeedback
                  initial={recsInsight.content?.recommendations ?? []}
                  initialState={recsInsight.state}
                  initialGeneratedAt={recsInsight.generatedAt?.toISOString() ?? null}
                  limit={3}
                  modeOverride={
                    aiMode === 'disabled'
                      ? 'disabled'
                      : aiMode === 'mock'
                        ? 'mock'
                        : undefined
                  }
                />
              </DashboardGridCell>
            </DashboardGrid>
          </ExecutiveSection>
        </div>
      </main>
    );
  });
}
