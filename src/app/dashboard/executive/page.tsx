import { Sparkles } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { getAIMode } from '@/lib/ai/config';
import { formatCompactTenantCurrency, formatTenantCurrency } from '@/lib/currency/format';
import { formatDate, formatNumber } from '@/lib/dates/format';
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

import {
  LiveDailyExecCard,
  LiveRecommendationsCard,
} from '../intelligence/_components/live-ai-card';

import { MetricCard } from '../_components/metric-card';
import {
  AttentionItem,
  AttentionList,
  DashboardGrid,
  DashboardGridCell,
  ExecutiveSection,
  InsightCard,
  SectionLink,
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
 * The "AI Intelligence" feed is placeholder content for v1 — the CP#15
 * scope is the layout + data plumbing; the actual insight generation
 * lands in a follow-up alongside the AI mode work.
 */
export default async function ExecutiveDashboardPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant, userId }) => {
    const filter = { range: 'last_90d', owner: { type: 'all' } } as const;
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
    ] = await Promise.all([
      pipelineByStageRunner(tenant.id, filter, ctx),
      winLossRateRunner(tenant.id, filter, ctx),
      repPerformanceRunner(tenant.id, filter, ctx),
      dealVelocityRunner(tenant.id, filter, ctx),
      revenueForecastRunner(
        tenant.id,
        { range: 'next_180d' as unknown as 'last_90d', owner: { type: 'all' } },
        ctx,
      ),
      emailEngagementRunner(tenant.id, filter, ctx),
      staleDealsRunner(tenant.id, filter, ctx),
      getDailyExecInsight(tenant.id, userId, today),
      getRecommendationInsight(tenant.id, userId),
    ]);

    const totalPipelineMinor = pipeline.rows
      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
      .reduce((s, r) => s + r.totalAmountMinor, 0);
    const wonRevenueMinor = pipeline.rows.find((r) => r.stage === 'won')?.totalAmountMinor ?? 0;

    const topRep = reps.rows.slice(0, 3);
    const staleByCriticality = [...stale.rows].sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        (b.daysSinceActivity ?? 0) - (a.daysSinceActivity ?? 0),
    );
    const attentionRows = staleByCriticality.slice(0, 6);

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
              one screen. Window: last 90 days for actuals · next 180 days for
              forecast.
            </p>
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
            subtitle="Closed deals + forecasted pipeline"
            action={<SectionLink href="/dashboard/reports/revenue-forecast" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Won revenue"
                  value={money(wonRevenueMinor)}
                  hint={`From ${pipeline.rows.find((r) => r.stage === 'won')?.count ?? 0} closed deals (90d)`}
                  tone="success"
                  href="/dashboard/reports/win-loss-rate"
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Likely forecast"
                  value={money(forecast.extras?.totalLikelyMinor ?? 0)}
                  hint={`${forecast.extras?.totalDeals ?? 0} open deals · ${Math.round((forecast.extras?.avgConfidence ?? 0) * 100)}% avg confidence`}
                  tone="info"
                  href="/dashboard/reports/revenue-forecast"
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Best case"
                  value={money(forecast.extras?.totalBestCaseMinor ?? 0)}
                  hint="If every open deal closes"
                  tone="success"
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <InsightCard
                  label="Win rate"
                  value={`${Math.round((winLoss.extras?.winRate ?? 0) * 100)}%`}
                  hint={`${winLoss.extras?.totalClosed ?? 0} closed in window`}
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

          <ExecutiveSection
            title="Pipeline health"
            subtitle="Active deal stages and total value in motion"
            action={<SectionLink href="/dashboard/reports/pipeline-by-stage" />}
          >
            <DashboardGrid>
              <DashboardGridCell span={4}>
                <MetricCard
                  label="Pipeline value"
                  value={money(totalPipelineMinor)}
                  hint={`Across ${pipeline.rows
                    .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
                    .reduce((s, r) => s + r.count, 0)} active deals`}
                  tone="info"
                />
              </DashboardGridCell>
              {pipeline.rows
                .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
                .map((row) => (
                  <DashboardGridCell key={row.stage} span={4}>
                    <MetricCard
                      label={row.stageLabel}
                      value={formatNumber(row.count)}
                      hint={`${money(row.totalAmountMinor)} in this stage`}
                      tone="neutral"
                    />
                  </DashboardGridCell>
                ))}
            </DashboardGrid>
          </ExecutiveSection>

          <DashboardGrid>
            <DashboardGridCell span={6}>
              <ExecutiveSection
                title="Top performers"
                subtitle="Highest revenue contributors in the last 90 days"
                action={<SectionLink href="/dashboard/reports/rep-performance" />}
              >
                <AttentionList emptyMessage="No closed deals in this window yet.">
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
                          meta={money(rep.revenueMinor)}
                          severity="info"
                        />
                      ))}
                </AttentionList>
              </ExecutiveSection>
            </DashboardGridCell>

            <DashboardGridCell span={6}>
              <ExecutiveSection
                title="Velocity & bottlenecks"
                subtitle="Where deals slow down between stages"
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
                    />
                  </DashboardGridCell>
                </DashboardGrid>
              </ExecutiveSection>
            </DashboardGridCell>
          </DashboardGrid>

          <ExecutiveSection
            title="Operational health"
            subtitle="Email deliverability and workflow signals"
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
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Stalled deals"
                  value={formatNumber(stale.rows.filter((r) => r.severity === 'critical' || r.severity === 'stale').length)}
                  hint="Need re-engagement"
                  tone="warning"
                />
              </DashboardGridCell>
              <DashboardGridCell span={3}>
                <MetricCard
                  label="Active deals"
                  value={formatNumber(
                    pipeline.rows
                      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
                      .reduce((s, r) => s + r.count, 0),
                  )}
                  hint="Currently in flight"
                  tone="neutral"
                />
              </DashboardGridCell>
            </DashboardGrid>
          </ExecutiveSection>

          <ExecutiveSection
            title="Attention queue"
            subtitle="Stalled deals sorted by signal severity"
            action={<SectionLink href="/dashboard/reports/stale-deals" />}
          >
            <AttentionList emptyMessage="Nothing stalled. Pipeline is healthy.">
              {attentionRows.length === 0
                ? null
                : attentionRows.map((row) => (
                    <AttentionItem
                      key={row.dealId}
                      title={row.name}
                      detail={`${DEAL_STAGE_LABELS[row.stage]} · ${row.daysSinceActivity ?? '∞'}d since activity${
                        row.daysSinceStageChange != null
                          ? ` · ${row.daysSinceStageChange}d in stage`
                          : ''
                      }`}
                      meta={money(row.amountMinor)}
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

function severityRank(s: 'ok' | 'watch' | 'stale' | 'critical'): number {
  switch (s) {
    case 'critical':
      return 3;
    case 'stale':
      return 2;
    case 'watch':
      return 1;
    default:
      return 0;
  }
}
