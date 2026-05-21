import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  CheckSquare,
  Inbox,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';

import { getRecommendationInsight } from '@/lib/intelligence/runner';
import { getAIMode } from '@/lib/ai/config';
import { getInboxCounts } from '@/lib/communications/threads/queries';
import { getTopPredictionsForTenant } from '@/lib/predictions/runner';
import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';
import { getMyTasksSummary } from '@/lib/tasks/queries';
import { cn } from '@/lib/utils';

import { RevenueFunnel } from '../revenue-funnel';
import { LiveRecommendationsCard } from '../../intelligence/_components/live-ai-card';
import { QuickActions } from '../overview-widgets';

/**
 * Sales Home — workflow-first, no KPI-card overload.
 *
 * Layout priority (top to bottom):
 *   1. Revenue Funnel (hero) — visual, motivating, revenue-weighted
 *   2. Today's Actions — overdue tasks + stale predictions + recs
 *   3. Communication Priority — failed deliveries + unread threads
 *   4. Quick Actions — keyboard-friendly create flows
 *
 * Everything composes existing runners + helpers; no new analytics
 * logic. AI is contextual — embedded in Today's Actions, not on a
 * separate "AI" page.
 */
export async function SalesHome({
  user,
  tenantName,
  pipelineRows,
  tenantId,
  currentUserId,
  money,
}: {
  user: { firstName: string | null };
  tenantName: string;
  pipelineRows: PipelineByStageRow[];
  tenantId: string;
  currentUserId: string;
  money: (amountMinor: number) => string;
}) {
  const aiMode = getAIMode();

  const [predictions, recsInsight, inboxCounts, myTasks] = await Promise.all([
    getTopPredictionsForTenant(tenantId, { limit: 8 }),
    getRecommendationInsight(tenantId, currentUserId),
    getInboxCounts(tenantId),
    getMyTasksSummary(tenantId, currentUserId),
  ]);

  const overdueTasks = myTasks.overdueCount;
  const stalePredictions = predictions.filter(
    (p) => p.kind === 'stale_risk' && p.value > 0.5,
  );
  const lowMomentum = predictions.filter(
    (p) => p.kind === 'deal_momentum' && p.value < 0.4,
  );

  return (
    <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-5 lg:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            {greeting(user.firstName)}
          </h1>
          <p className="mt-1 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">
            Here&rsquo;s your pipeline, your priorities, and what needs attention
            today. <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">{tenantName}</span>
          </p>
        </div>
      </header>

      {/* 1. Revenue Funnel — HERO */}
      <RevenueFunnel rows={pipelineRows} formatCurrency={money} />

      {/* 2. Today's Actions — split into two columns on wide screens */}
      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A] lg:col-span-7">
          <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-300" aria-hidden />
              <h2 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
                Today&rsquo;s actions
              </h2>
            </div>
            <Link
              href="/dashboard/tasks"
              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
            >
              All tasks
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          </header>

          <ActionRow
            label="Overdue tasks"
            value={overdueTasks}
            href="/dashboard/tasks?filter=overdue"
            tone={overdueTasks > 0 ? 'danger' : 'neutral'}
            description={
              overdueTasks > 0
                ? 'Resolve these first — they pile up.'
                : 'Nothing overdue. Nice.'
            }
          />
          <ActionRow
            label="Deals stalling"
            value={stalePredictions.length}
            href="/dashboard/reports/stale-deals"
            tone={stalePredictions.length > 0 ? 'warning' : 'neutral'}
            description={
              stalePredictions[0]?.explanation ?? 'No stalling deals detected.'
            }
          />
          <ActionRow
            label="Low momentum"
            value={lowMomentum.length}
            href="/dashboard/deals"
            tone={lowMomentum.length > 0 ? 'warning' : 'neutral'}
            description={
              lowMomentum[0]?.explanation ??
              'Pipeline is moving — keep the cadence.'
            }
          />
        </section>

        {/* AI assistant column — contextual recommendations */}
        <section className="lg:col-span-5">
          <LiveRecommendationsCard
            tenantId={tenantId}
            title="Suggested next actions"
            subtitle="AI-ranked by leverage"
            tone="info"
            summaryId={null}
            hideFeedback
            limit={4}
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
        </section>
      </div>

      {/* 3. Communication Priority */}
      <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-indigo-600 dark:text-indigo-300" aria-hidden />
            <h2 className="text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Communication priority
            </h2>
          </div>
          <Link
            href="/dashboard/communications"
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
          >
            Open inbox
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </header>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <CommTile
            label="Unread threads"
            value={inboxCounts.unread}
            href="/dashboard/communications?view=inbox"
            tone={inboxCounts.unread > 0 ? 'info' : 'neutral'}
            icon={Inbox}
          />
          <CommTile
            label="Failed deliveries"
            value={inboxCounts.failed}
            href="/dashboard/communications?view=failed"
            tone={inboxCounts.failed > 0 ? 'danger' : 'neutral'}
            icon={AlertTriangle}
          />
          <CommTile
            label="Active threads"
            value={inboxCounts.active}
            href="/dashboard/communications"
            tone="neutral"
            icon={Briefcase}
          />
        </div>
      </section>

      {/* 4. Quick actions */}
      <section className="mt-4">
        <QuickActions canCreate={true} />
      </section>
    </main>
  );
}

function greeting(firstName: string | null): string {
  const name = firstName ? `, ${firstName}` : '';
  const hour = new Date().getUTCHours();
  if (hour < 12) return `Good morning${name}.`;
  if (hour < 18) return `Good afternoon${name}.`;
  return `Good evening${name}.`;
}

function ActionRow({
  label,
  value,
  href,
  tone,
  description,
}: {
  label: string;
  value: number;
  href: string;
  tone: 'info' | 'warning' | 'danger' | 'neutral';
  description: string;
}) {
  const toneClass = {
    info: 'text-indigo-700 dark:text-indigo-300',
    warning: 'text-amber-700 dark:text-amber-300',
    danger: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-700 dark:text-[#A1A1AA]',
  }[tone];
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 border-b border-slate-100 py-2.5 last:border-b-0 hover:bg-slate-50/60 dark:border-[#1F1F1F] dark:hover:bg-[#111111]"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
          {label}
        </div>
        <div className="mt-0.5 truncate text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
          {description}
        </div>
      </div>
      <div className={cn('flex-shrink-0 font-mono text-xl font-semibold tabular-nums', toneClass)}>
        {value}
      </div>
    </Link>
  );
}

function CommTile({
  label,
  value,
  href,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  href: string;
  tone: 'info' | 'warning' | 'danger' | 'neutral';
  icon: typeof Inbox;
}) {
  const ring = {
    info: 'border-indigo-200 bg-indigo-50/60 text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200',
    warning:
      'border-amber-200 bg-amber-50/60 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
    danger:
      'border-rose-200 bg-rose-50/60 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
    neutral:
      'border-slate-200 bg-white text-slate-700 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]',
  }[tone];
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 transition-shadow hover:shadow-sm',
        ring,
      )}
    >
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
          {label}
        </div>
        <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
          {value}
        </div>
      </div>
      <Icon className="h-5 w-5 flex-shrink-0 opacity-60" aria-hidden />
      <Sparkles className="hidden" aria-hidden />
    </Link>
  );
}
