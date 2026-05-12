import { currentUser } from '@clerk/nextjs/server';
import Link from 'next/link';

import { listRecentActivity } from '@/lib/activity/queries';
import { withTenantSession } from '@/lib/auth-guard';
import {
  getDashboardOverview,
  getPipelineCreatedTrend,
  getRecentWins,
  getStaleDeals,
  getUpcomingFollowUps,
  getWonLostTrend,
  getWorkflowHealth,
} from '@/lib/dashboard/queries';
import { ensureMembership } from '@/lib/membership';
import { canManageCompanies } from '@/lib/rbac';
import { getMyTasksSummary } from '@/lib/tasks/queries';

import { LiveActivityFeed } from './activity/_components/live-activity-feed';
import {
  MyTasksCard,
  PipelineTrendSparkline,
  RecentWinsCard,
  StaleDealsCard,
  UpcomingFollowUpsCard,
  WonLostTrendCard,
  WorkflowHealthCard,
} from './_components/intel-widgets';
import {
  KpiStrip,
  PipelineDistribution,
  QuickActions,
} from './_components/overview-widgets';

export const metadata = {
  title: 'Dashboard',
};

const PIPELINE_TREND_DAYS = 14;
const WON_LOST_TREND_DAYS = 30;
const STALE_DAYS = 14;
const FOLLOW_UP_LOOK_AHEAD = 14;

export default async function DashboardPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    const [
      user,
      membership,
      recentPage,
      overview,
      wonLostTrend,
      pipelineCreatedTrend,
      staleDeals,
      followUps,
      recentWins,
      workflowHealth,
      myTasks,
    ] = await Promise.all([
      currentUser(),
      ensureMembership(),
      listRecentActivity(tenant.id, { size: 25 }),
      getDashboardOverview(tenant.id),
      getWonLostTrend(tenant.id, WON_LOST_TREND_DAYS),
      getPipelineCreatedTrend(tenant.id, PIPELINE_TREND_DAYS),
      getStaleDeals(tenant.id, { staleDays: STALE_DAYS, limit: 5 }),
      getUpcomingFollowUps(tenant.id, {
        lookAheadDays: FOLLOW_UP_LOOK_AHEAD,
        limit: 6,
      }),
      getRecentWins(tenant.id, 5),
      getWorkflowHealth(tenant.id, 7),
      getMyTasksSummary(tenant.id, userId),
    ]);

    const canCreate = canManageCompanies(membership?.role ?? null);
    const recentActivity = recentPage.items;

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-5 sm:px-5 lg:px-6">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[18px] font-semibold leading-tight tracking-tight text-slate-900">
              Welcome back{user?.firstName ? `, ${user.firstName}` : ''}.
            </h1>
            <p className="mt-0.5 text-[12px] text-slate-500">
              <span className="font-medium text-slate-700">{tenant.name}</span>
              {membership ? ` · ${membership.role}` : ''}
            </p>
          </div>
          <div className="w-full max-w-xs">
            <PipelineTrendSparkline
              trend={pipelineCreatedTrend}
              days={PIPELINE_TREND_DAYS}
            />
          </div>
        </header>

        <KpiStrip overview={overview} />

        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <PipelineDistribution byStage={overview.dealsByStage} />
          </div>
          <QuickActions canCreate={canCreate} />
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <WonLostTrendCard trend={wonLostTrend} />
          </div>
          <WorkflowHealthCard health={workflowHealth} />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MyTasksCard summary={myTasks} />
          <UpcomingFollowUpsCard rows={followUps} />
          <StaleDealsCard rows={staleDeals} staleDays={STALE_DAYS} />
          <RecentWinsCard rows={recentWins} />
        </div>

        <section className="mt-3 rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
          <header className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold text-slate-900">
              Recent activity
            </h2>
            <Link
              href="/dashboard/activity"
              className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
            >
              View all →
            </Link>
          </header>
          <LiveActivityFeed
            tenantId={tenant.id}
            initialRows={recentActivity}
            emptyMessage="Nothing here yet — activity will appear once you start adding records."
          />
        </section>
      </main>
    );
  });
}
