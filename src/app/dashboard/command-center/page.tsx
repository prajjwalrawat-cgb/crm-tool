import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Brain,
  Mail,
  Minus,
  Sparkles,
  Target,
  TrendingUp,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';

import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import { getInboxCounts } from '@/lib/communications/threads/queries';
import { formatCompactTenantCurrency, formatTenantCurrency } from '@/lib/currency/format';
import { formatRelativeTime } from '@/lib/dates/format';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import {
  getDailyExecInsight,
  getPipelineSummaryInsight,
  getRecommendationInsight,
  getRiskFlagInsight,
} from '@/lib/intelligence/runner';
import { readIntelligenceTimeline } from '@/lib/intelligence/timeline';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import { getTopPredictionsForTenant } from '@/lib/predictions/runner';
import type { Prediction, PredictionKind } from '@/lib/predictions/types';
import { pipelineByStageRunner } from '@/lib/reports/queries/pipeline-by-stage';
import { cn } from '@/lib/utils';

import {
  LiveDailyExecCard,
  LiveRecommendationsCard,
} from '../intelligence/_components/live-ai-card';

export const metadata = {
  title: 'Command Center',
};

/**
 * Command Center — the operational intelligence hub. Server-rendered
 * triage view that composes:
 *   - predictions (deal momentum / stale risk / close probability)
 *   - risk-flag insight set (AI-derived)
 *   - recommendation insight set (AI-derived, with learned-pattern provenance)
 *   - inbox counts (failed / unread)
 *   - pipeline by stage
 *   - unified intelligence timeline (last 24h)
 *
 * Hot path: ~7 parallel server queries, all indexed. No N+1 — entity
 * lookups for the timeline are folded into the SQL UNION.
 */
export default async function CommandCenterPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant, userId }) => {
    const filter = { range: 'last_90d', owner: { type: 'all' } } as const;
    const ctx = { currentUserId: userId };
    const today = new Date().toISOString().slice(0, 10);
    const aiMode = getAIMode();

    const [
      settings,
      predictions,
      riskInsight,
      recsInsight,
      pipelineSummary,
      inboxCounts,
      pipelineByStage,
      dailyInsight,
      timeline,
    ] = await Promise.all([
      getOrgSettings(tenant.id),
      getTopPredictionsForTenant(tenant.id, { limit: 16 }),
      getRiskFlagInsight(tenant.id, userId),
      getRecommendationInsight(tenant.id, userId),
      getPipelineSummaryInsight(tenant.id, userId),
      getInboxCounts(tenant.id),
      pipelineByStageRunner(tenant.id, filter, ctx),
      getDailyExecInsight(tenant.id, userId, today),
      readIntelligenceTimeline(tenant.id, { hours: 24, limit: 30 }),
    ]);

    void pipelineSummary; // reserved for the bottlenecks pill (CP#16F polish)
    const money = (minor: number) =>
      settings.compactNumbers
        ? formatCompactTenantCurrency(minor, settings)
        : formatTenantCurrency(minor, settings);

    const criticalRisks = predictions.filter(
      (p) => (p.kind === 'stale_risk' || p.kind === 'comm_risk') && p.value > 0.6,
    );
    const wateringDeals = predictions.filter(
      (p) => p.kind === 'deal_momentum' && p.value < 0.4,
    );
    const aiRecCount = recsInsight.content?.recommendations.length ?? 0;
    const aiRiskCount = riskInsight.content?.flags.length ?? 0;

    const pipelineMinor = pipelineByStage.rows
      .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
      .reduce((s, r) => s + r.totalAmountMinor, 0);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Brain className="h-3 w-3" aria-hidden />
              Command Center
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Operational intelligence at a glance
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Predictive signals, AI recommendations, and the last 24h of
              activity — composed from the same data the rest of the app
              reads. Every signal explains itself.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-right dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              AI mode
            </div>
            <div className="font-mono text-sm font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {aiMode}
            </div>
          </div>
        </header>

        {/* ----- KPI strip ----- */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi
            label="Critical predictions"
            value={criticalRisks.length}
            icon={AlertTriangle}
            tone="danger"
            href="#predictions"
          />
          <Kpi
            label="AI recommendations"
            value={aiRecCount}
            icon={Sparkles}
            tone="info"
            href="/dashboard/intelligence"
          />
          <Kpi
            label="Pipeline value"
            value={money(pipelineMinor)}
            icon={TrendingUp}
            tone="success"
            href="/dashboard/executive"
          />
          <Kpi
            label="Inbox issues"
            value={inboxCounts.failed}
            icon={Mail}
            tone={inboxCounts.failed > 0 ? 'warning' : 'neutral'}
            href="/dashboard/communications?view=failed"
          />
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-12">
          {/* ----- Critical Risks ----- */}
          <Section
            title="Critical risks"
            subtitle="Deals with stale signals or low momentum"
            span={6}
            icon={AlertTriangle}
            tone="danger"
            id="predictions"
            cta={{ href: '/dashboard/reports/stale-deals', label: 'Stale deals report' }}
          >
            {criticalRisks.length === 0 && wateringDeals.length === 0 ? (
              <Empty label="No critical risks. Pipeline is healthy." />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-[#1F1F1F]">
                {[...criticalRisks, ...wateringDeals]
                  .slice(0, 6)
                  .map((p) => (
                    <PredictionRow key={`${p.kind}-${p.entityId}`} prediction={p} />
                  ))}
              </ul>
            )}
          </Section>

          {/* ----- Recommended Actions ----- */}
          <Section
            title="Recommended actions"
            subtitle="AI-generated next-best actions, ranked by leverage"
            span={6}
            icon={Sparkles}
            tone="info"
            cta={{ href: '/dashboard/intelligence', label: 'Open intelligence' }}
          >
            <LiveRecommendationsCard
              tenantId={tenant.id}
              title="Top recommendations"
              subtitle=""
              tone="neutral"
              summaryId={null}
              hideFeedback
              limit={5}
              initial={recsInsight.content?.recommendations ?? []}
              initialState={recsInsight.state}
              initialGeneratedAt={recsInsight.generatedAt?.toISOString() ?? null}
              modeOverride={
                aiMode === 'disabled'
                  ? 'disabled'
                  : aiMode === 'mock'
                    ? 'mock'
                    : undefined
              }
            />
          </Section>

          {/* ----- Pipeline Movement ----- */}
          <Section
            title="Pipeline movement"
            subtitle="Per-stage counts and value distribution"
            span={6}
            icon={TrendingUp}
            tone="success"
            cta={{ href: '/dashboard/executive', label: 'Executive view' }}
          >
            <ul className="space-y-1.5">
              {pipelineByStage.rows
                .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
                .map((r) => (
                  <li
                    key={r.stage}
                    className="flex items-baseline justify-between rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[12px] dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
                  >
                    <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
                      {DEAL_STAGE_LABELS[r.stage]}
                    </span>
                    <span className="flex items-baseline gap-3">
                      <span className="font-mono tabular-nums text-slate-500 dark:text-[#A1A1AA]">
                        {r.count} deals
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
                        {money(r.totalAmountMinor)}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          </Section>

          {/* ----- AI Priorities (daily exec) ----- */}
          <Section
            title="AI priorities"
            subtitle={`Daily summary for ${today}`}
            span={6}
            icon={Brain}
            tone="info"
            cta={{ href: '/dashboard/intelligence', label: 'Open intelligence' }}
          >
            <LiveDailyExecCard
              tenantId={tenant.id}
              id={today}
              title=""
              subtitle=""
              tone="neutral"
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
          </Section>

          {/* ----- Communication Alerts ----- */}
          <Section
            title="Communication alerts"
            subtitle="Threads needing attention"
            span={4}
            icon={Mail}
            tone={inboxCounts.failed > 0 ? 'warning' : 'neutral'}
            cta={{ href: '/dashboard/communications', label: 'Open inbox' }}
          >
            <ul className="space-y-1.5 text-[12px]">
              <AlertRow
                label="Failed deliveries"
                value={inboxCounts.failed}
                href="/dashboard/communications?view=failed"
                tone={inboxCounts.failed > 0 ? 'danger' : 'neutral'}
              />
              <AlertRow
                label="Unread threads"
                value={inboxCounts.unread}
                href="/dashboard/communications?view=inbox"
                tone={inboxCounts.unread > 0 ? 'warning' : 'neutral'}
              />
              <AlertRow
                label="Active threads"
                value={inboxCounts.active}
                href="/dashboard/communications"
                tone="info"
              />
            </ul>
          </Section>

          {/* ----- Team Activity (last 24h timeline) ----- */}
          <Section
            title="Team activity"
            subtitle="Unified intelligence timeline · last 24h"
            span={8}
            icon={Activity}
            tone="info"
            cta={{ href: '/dashboard/activity', label: 'All activity' }}
          >
            {timeline.length === 0 ? (
              <Empty label="Nothing happened in the last 24 hours." />
            ) : (
              <ul className="space-y-1.5">
                {timeline.slice(0, 10).map((row, i) => (
                  <li key={`${row.kind}-${row.entityId}-${i}`}>
                    <TimelineRow row={row} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ----- AI Risks ----- */}
          <Section
            title="AI risk feed"
            subtitle="Deals the model flagged in the last refresh"
            span={6}
            icon={Workflow}
            tone="warning"
            cta={{ href: '/dashboard/intelligence', label: 'Risk dashboard' }}
          >
            {aiRiskCount === 0 ? (
              <Empty label="No model-flagged risks. Will refresh on next data change." />
            ) : (
              <ul className="space-y-1.5">
                {riskInsight.content?.flags.slice(0, 5).map((flag, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[12px] dark:border-[#1F1F1F]/70 dark:bg-[#111111]"
                  >
                    <span
                      className={cn(
                        'mt-1 inline-block h-2 w-2 flex-shrink-0 rounded-full',
                        flag.severity === 'danger'
                          ? 'bg-rose-500'
                          : flag.severity === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-indigo-500',
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      {flag.entity ? (
                        <Link
                          href={`/dashboard/deals/${flag.entity.id}`}
                          className="truncate text-[12px] font-medium text-slate-900 hover:text-indigo-600 dark:text-[#FAFAFA] dark:hover:text-indigo-300"
                        >
                          {flag.entity.name}
                        </Link>
                      ) : (
                        <span className="truncate text-[12px] font-medium text-slate-900 dark:text-[#FAFAFA]">
                          {flag.title}
                        </span>
                      )}
                      <div className="mt-0.5 line-clamp-1 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                        {flag.reason}
                      </div>
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-slate-400 dark:text-[#71717A]">
                      {Math.round(flag.confidence * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ----- Executive Highlights ----- */}
          <Section
            title="Executive highlights"
            subtitle="Top-of-funnel signal for the briefing layer"
            span={6}
            icon={Target}
            tone="info"
            cta={{ href: '/dashboard/executive', label: 'Full executive view' }}
          >
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <Highlight label="Active deals" value={String(pipelineByStage.rows
                .filter((r) => r.stage !== 'won' && r.stage !== 'lost')
                .reduce((s, r) => s + r.count, 0))} />
              <Highlight label="Predictions tracked" value={String(predictions.length)} />
              <Highlight label="AI flags" value={String(aiRiskCount)} />
              <Highlight label="AI recs" value={String(aiRecCount)} />
            </div>
          </Section>
        </div>
      </main>
    );
  });
}

/* ---------- helpers ---------- */

function Kpi({
  label,
  value,
  icon: Icon,
  tone,
  href,
}: {
  label: string;
  value: number | string;
  icon: typeof AlertTriangle;
  tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  href: string;
}) {
  const toneClass = {
    info: 'border-indigo-200 bg-indigo-50/60 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300',
    success: 'border-emerald-200 bg-emerald-50/60 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
    danger: 'border-rose-200 bg-rose-50/60 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
    neutral: 'border-slate-200 bg-white text-slate-700 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA]',
  } as const;

  return (
    <Link
      href={href}
      className={cn(
        'flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 transition-shadow hover:shadow-sm',
        toneClass[tone],
      )}
    >
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-75">
          {label}
        </div>
        <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
          {value}
        </div>
      </div>
      <Icon className="h-5 w-5 flex-shrink-0 opacity-60" aria-hidden />
    </Link>
  );
}

function Section({
  title,
  subtitle,
  span,
  icon: Icon,
  tone,
  id,
  cta,
  children,
}: {
  title: string;
  subtitle?: string;
  span: 4 | 6 | 8 | 12;
  icon: typeof AlertTriangle;
  tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  id?: string;
  cta?: { href: string; label: string };
  children: React.ReactNode;
}) {
  const colMap = {
    4: 'lg:col-span-4',
    6: 'lg:col-span-6',
    8: 'lg:col-span-8',
    12: 'lg:col-span-12',
  } as const;
  const tint = {
    info: 'text-indigo-600 dark:text-indigo-300',
    success: 'text-emerald-600 dark:text-emerald-300',
    warning: 'text-amber-700 dark:text-amber-300',
    danger: 'text-rose-600 dark:text-rose-300',
    neutral: 'text-slate-500 dark:text-[#A1A1AA]',
  } as const;
  return (
    <section
      id={id}
      className={cn(
        'col-span-12 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        colMap[span],
      )}
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-start gap-2">
          <Icon className={cn('mt-0.5 h-4 w-4', tint[tone])} aria-hidden />
          <div>
            <h2 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
        {cta ? (
          <Link
            href={cta.href}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200"
          >
            {cta.label}
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function PredictionRow({ prediction }: { prediction: Prediction }) {
  const TrendIcon =
    prediction.trend === 'up' ? ArrowUp : prediction.trend === 'down' ? ArrowDown : Minus;
  const valuePct = Math.round(prediction.value * 100);
  const isDeal = prediction.entityType === 'deal';
  return (
    <li>
      <Link
        href={isDeal ? `/dashboard/deals/${prediction.entityId}` : `/dashboard/communications/${prediction.entityId}`}
        className="flex items-start gap-3 px-1 py-2 transition-colors hover:bg-slate-50/70 dark:hover:bg-[#181818]"
      >
        <span
          className={cn(
            'mt-1.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
            prediction.value > 0.6 && (prediction.kind === 'stale_risk' || prediction.kind === 'comm_risk')
              ? 'bg-rose-500'
              : prediction.value < 0.4 && prediction.kind === 'deal_momentum'
                ? 'bg-amber-500'
                : 'bg-indigo-500',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12.5px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {prediction.entityName}
            </span>
            <span className="flex flex-shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-slate-500 dark:text-[#A1A1AA]">
              <TrendIcon className="h-2.5 w-2.5" aria-hidden />
              {valuePct}%
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
            <span className="rounded-full bg-slate-100 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
              {labelKind(prediction.kind)}
            </span>{' '}
            {prediction.explanation}
          </div>
        </div>
      </Link>
    </li>
  );
}

function labelKind(k: PredictionKind): string {
  switch (k) {
    case 'close_probability':
      return 'CLOSE';
    case 'deal_momentum':
      return 'MOMENTUM';
    case 'stale_risk':
      return 'STALE';
    case 'comm_risk':
      return 'COMM';
  }
}

function TimelineRow({ row }: { row: Awaited<ReturnType<typeof readIntelligenceTimeline>>[number] }) {
  const dot = {
    info: 'bg-indigo-500',
    success: 'bg-emerald-500',
    warning: 'bg-amber-500',
    danger: 'bg-rose-500',
  }[row.severity];
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[11.5px] dark:border-[#1F1F1F]/70 dark:bg-[#111111]">
      <span className={cn('mt-1 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full', dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-slate-800 dark:text-[#FAFAFA]">
            {row.title}
          </span>
          <span className="flex-shrink-0 font-mono text-[10px] tabular-nums text-slate-400 dark:text-[#71717A]">
            {formatRelativeTime(new Date(row.occurredAt), new Date())}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
          <span className="rounded bg-slate-100 px-1 py-px font-mono dark:bg-[#181818]">{row.kind}</span>
          <span>{row.label}</span>
        </div>
      </div>
    </div>
  );
}

function AlertRow({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone: 'info' | 'warning' | 'danger' | 'neutral';
}) {
  const valueClass = {
    info: 'text-indigo-700 dark:text-indigo-300',
    warning: 'text-amber-700 dark:text-amber-300',
    danger: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-700 dark:text-[#A1A1AA]',
  }[tone];
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 text-[12px] hover:bg-slate-50/70 dark:border-[#1F1F1F]/70 dark:bg-[#111111] dark:hover:bg-[#181818]"
      >
        <span className="text-slate-600 dark:text-[#A1A1AA]">{label}</span>
        <span className={cn('font-mono font-semibold tabular-nums', valueClass)}>
          {value}
        </span>
      </Link>
    </li>
  );
}

function Highlight({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200/70 bg-white/50 px-2.5 py-1.5 dark:border-[#1F1F1F]/70 dark:bg-[#111111]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-base font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">
        {value}
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/40 px-3 py-3 text-center text-[11.5px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#A1A1AA]">
      {label}
    </div>
  );
}
