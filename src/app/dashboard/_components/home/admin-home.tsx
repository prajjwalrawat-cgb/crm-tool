import { currentUser } from '@clerk/nextjs/server';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Cog,
  Gauge,
  Mail,
  Radar,
  Sparkles,
  Workflow as WorkflowIcon,
  XCircle,
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
  getDashboardOverview,
  getRevenueTrend,
  getWorkflowHealth,
} from '@/lib/dashboard/queries';
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
import { cn } from '@/lib/utils';

import { RevenueTrendChart } from '../revenue-trend-chart';
import { StageConversionBars } from '../stage-conversion-bars';
import { StageDonut } from '../stage-donut';

import { Greeting } from './greeting';

/**
 * Admin Home — operational + business visibility for the org's
 * caretaker. Composes the same revenue funnel everyone else sees
 * (scoped org-wide), plus ops health (AI usage, email delivery,
 * workflow runs, inbox failures) and AI insight summaries.
 *
 * Admin gets the most surfaces, but the page is still organized
 * around the funnel — the question "is the business closing?" matters
 * to admins too. Ops health lives below the funnel, not above it.
 */
export async function AdminHome({
  tenantId,
  tenantName,
  userId,
}: {
  tenantId: string;
  tenantName: string;
  userId: string;
}) {
  const [
    user,
    settings,
    overview,
    pipeline,
    trend,
    workflowHealth,
    workflowStats,
    aiStats,
    emailStats,
    inbox,
    recs,
    risks,
    savedChartView,
    savedStageConversionView,
    savedStageDonutView,
  ] = await Promise.all([
    currentUser(),
    getOrgSettings(tenantId),
    getDashboardOverview(tenantId),
    pipelineByStageRunner(
      tenantId,
      { range: 'last_90d', owner: { type: 'all' } },
      { currentUserId: userId },
    ),
    getRevenueTrend(tenantId, { days: 90, ownerId: null }),
    getWorkflowHealth(tenantId, 7),
    getWorkflowStats(tenantId, 24),
    getAiInvocationStats(tenantId, 24),
    getEmailDeliveryStats(tenantId, 24),
    getInboxCounts(tenantId),
    getRecommendationInsight(tenantId, userId),
    getRiskFlagInsight(tenantId, userId),
    readRevenueTrendView({ tenantId, userId }),
    readStageConversionView({ tenantId, userId }),
    readStageDonutView({ tenantId, userId }),
  ]);

  const money = (m: number) =>
    settings.compactNumbers
      ? formatCompactTenantCurrency(m, settings)
      : formatTenantCurrency(m, settings);

  const recsCount = recs.content?.recommendations.length ?? 0;
  const risksCount = risks.content?.flags.length ?? 0;
  const aiErrorRate =
    aiStats.totalCalls > 0
      ? aiStats.errorCount / aiStats.totalCalls
      : 0;

  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
      <Greeting
        firstName={user?.firstName}
        tenantName={tenantName}
        personaLabel="Administrator"
        className="mb-5"
      />

      {/* Org-level numbers at a glance */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <OrgKpi label="Companies" value={overview.companies.toLocaleString()} />
        <OrgKpi label="Contacts" value={overview.contacts.toLocaleString()} />
        <OrgKpi label="Active deals" value={overview.dealsActive.toLocaleString()} />
        <OrgKpi label="Pipeline" value={money(overview.pipelineMinor)} mono />
        <OrgKpi label="Won · 30d" value={overview.wonRecent.toLocaleString()} tone="emerald" />
        <OrgKpi label="Lost · 30d" value={overview.lostRecent.toLocaleString()} tone="rose" />
      </div>

      {/* Hero — org-wide revenue trend chart. Currency CONTEXT (not
          a formatter function) crosses the RSC boundary cleanly. */}
      <div className="mt-5">
        <RevenueTrendChart
          data={trend}
          currency={settings}
          title="Organization revenue trend"
          subtitle={`Last 90 days · ${tenantName}`}
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
          title="Organization pipeline by stage"
          subtitle="Revenue-weighted bars · stage-to-stage conversion"
          initialConfig={savedStageConversionView?.config ?? null}
          initialTitleOverride={savedStageConversionView?.title ?? null}
          persona="admin"
        />
        <StageDonut
          rows={pipeline.rows}
          currency={settings}
          className="lg:col-span-1"
          title="Organization-wide"
          subtitle="Deal-count distribution across all owners"
          initialConfig={savedStageDonutView?.config ?? null}
          initialTitleOverride={savedStageDonutView?.title ?? null}
          persona="admin"
        />
      </div>

      <div className="mt-4">
        <OpsHealthCard
          workflowStats={workflowStats}
          workflowHealth={workflowHealth}
          aiStats={aiStats}
          aiErrorRate={aiErrorRate}
          emailStats={emailStats}
          inbox={inbox}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <AISignalsCard recsCount={recsCount} risksCount={risksCount} aiStats={aiStats} />
        <AdminQuickLinks />
      </div>
    </main>
  );
}

/* ============================================================ */

function OrgKpi({
  label,
  value,
  tone = 'slate',
  mono = false,
}: {
  label: string;
  value: string;
  tone?: 'slate' | 'emerald' | 'rose';
  mono?: boolean;
}) {
  const valueClass = {
    slate: 'text-slate-900 dark:text-[#FAFAFA]',
    emerald: 'text-emerald-700 dark:text-emerald-300',
    rose: 'text-rose-700 dark:text-rose-300',
  }[tone];
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-[18px] font-semibold leading-none tabular-nums',
          mono && 'font-mono text-[14px]',
          valueClass,
        )}
      >
        {value}
      </div>
    </div>
  );
}

/* ============================================================ */
/* Ops health card                                               */
/* ============================================================ */

function OpsHealthCard({
  workflowStats,
  workflowHealth,
  aiStats,
  aiErrorRate,
  emailStats,
  inbox,
  className,
}: {
  workflowStats: {
    totalRuns: number;
    running: number;
    completed: number;
    failed: number;
  };
  workflowHealth: { lastSuccessAt: Date | null; oldestRunningAt: Date | null };
  aiStats: {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    totalTokens: number;
  };
  aiErrorRate: number;
  emailStats: { sent: number; failed: number; exhausted: number };
  inbox: { active: number; unread: number; failed: number };
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
        className,
      )}
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <Gauge className="h-3 w-3" aria-hidden />
            Operations
          </div>
          <h2 className="mt-2 text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            Platform health · last 24h
          </h2>
        </div>
        <Link
          href="/dashboard/ops"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          Operations <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HealthTile
          icon={WorkflowIcon}
          label="Workflows"
          primary={`${workflowStats.completed}/${workflowStats.totalRuns}`}
          secondary={
            workflowStats.failed > 0
              ? `${workflowStats.failed} failed`
              : workflowStats.running > 0
                ? `${workflowStats.running} running`
                : 'all clear'
          }
          tone={
            workflowStats.failed > 0
              ? 'danger'
              : workflowStats.running > 0
                ? 'info'
                : 'success'
          }
        />
        <HealthTile
          icon={Brain}
          label="AI calls"
          primary={aiStats.totalCalls.toLocaleString()}
          secondary={
            aiStats.errorCount > 0
              ? `${Math.round(aiErrorRate * 100)}% errors`
              : `${aiStats.totalTokens.toLocaleString()} tok`
          }
          tone={
            aiStats.errorCount > 0 && aiErrorRate > 0.1
              ? 'danger'
              : aiStats.errorCount > 0
                ? 'warning'
                : 'success'
          }
        />
        <HealthTile
          icon={Mail}
          label="Email"
          primary={emailStats.sent.toLocaleString()}
          secondary={
            emailStats.exhausted > 0
              ? `${emailStats.exhausted} exhausted`
              : emailStats.failed > 0
                ? `${emailStats.failed} retrying`
                : 'all sent'
          }
          tone={
            emailStats.exhausted > 0
              ? 'danger'
              : emailStats.failed > 0
                ? 'warning'
                : 'success'
          }
        />
        <HealthTile
          icon={Radar}
          label="Inbox"
          primary={inbox.active.toLocaleString()}
          secondary={
            inbox.failed > 0
              ? `${inbox.failed} failed`
              : inbox.unread > 0
                ? `${inbox.unread} unread`
                : 'clean'
          }
          tone={
            inbox.failed > 0
              ? 'danger'
              : inbox.unread > 0
                ? 'info'
                : 'success'
          }
        />
      </div>

      {workflowHealth.oldestRunningAt && workflowStats.running > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11px] dark:border-amber-500/30 dark:bg-amber-500/10">
          <AlertTriangle
            className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-600 dark:text-amber-300"
            aria-hidden
          />
          <span className="text-amber-800 dark:text-amber-200">
            Oldest running workflow started{' '}
            {formatRelative(workflowHealth.oldestRunningAt)} ago — check Operations.
          </span>
        </div>
      ) : null}
    </section>
  );
}

function HealthTile({
  icon: Icon,
  label,
  primary,
  secondary,
  tone,
}: {
  icon: typeof Gauge;
  label: string;
  primary: string;
  secondary: string;
  tone: 'success' | 'info' | 'warning' | 'danger';
}) {
  const toneClass = {
    success: 'border-emerald-200/60 bg-emerald-50/40 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/5 dark:text-emerald-300',
    info: 'border-indigo-200/60 bg-indigo-50/40 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/5 dark:text-indigo-300',
    warning: 'border-amber-200/60 bg-amber-50/40 text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300',
    danger: 'border-rose-200/60 bg-rose-50/40 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/5 dark:text-rose-300',
  }[tone];
  const IconStatus = tone === 'success' ? CheckCircle2 : tone === 'danger' ? XCircle : Icon;
  return (
    <div className={cn('rounded-lg border px-2.5 py-2', toneClass)}>
      <div className="flex items-center gap-1.5">
        <IconStatus className="h-3 w-3 opacity-80" aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-90">
          {label}
        </span>
      </div>
      <div className="mt-1 font-mono text-[15px] font-semibold tabular-nums">
        {primary}
      </div>
      <div className="mt-0.5 text-[10.5px] opacity-75">{secondary}</div>
    </div>
  );
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
              className="h-4 w-4 flex-shrink-0 text-indigo-600 dark:text-indigo-300"
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
              className="h-3 w-3 flex-shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500 dark:text-[#3F3F46]"
              aria-hidden
            />
          </Link>
        ))}
      </div>
    </section>
  );
}
