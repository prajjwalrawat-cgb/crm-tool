import { redirect } from 'next/navigation';

import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import {
  getAiInvocationStats,
  getRecentAiInvocations,
  getRecentWorkflowRuns,
  getWorkflowStats,
} from '@/lib/ops/queries';
import { recentErrors, recentLogs, snapshotMetrics } from '@/lib/observability';
import { can } from '@/lib/rbac';

import { AiSection } from './_components/ai-section';
import { ErrorsSection } from './_components/errors-section';
import { LatencySection } from './_components/latency-section';
import { LogsSection } from './_components/logs-section';
import { OverviewSection } from './_components/overview-section';
import { RealtimeSection } from './_components/realtime-section';
import { WorkflowsSection } from './_components/workflows-section';

export const metadata = { title: 'Operations' };

// In-memory metrics + recent logs + recent errors live on the Node
// process. The page must always re-read them; cache it and the surface
// turns into a stale snapshot.
export const dynamic = 'force-dynamic';

export default async function OpsPage() {
  return await withTenantSession(async ({ tenant }) => {
    const membership = await requireMembership();
    // Ops is admin/owner-only. Members shouldn't see cross-cutting
    // platform health (other tenants' aggregate counts via the in-memory
    // metrics surface).
    if (!can(membership.role, 'manageMembers')) {
      redirect('/dashboard');
    }

    const [aiStats, recentAi, runStats, recentRuns] = await Promise.all([
      getAiInvocationStats(tenant.id, 24),
      getRecentAiInvocations(tenant.id),
      getWorkflowStats(tenant.id, 24),
      getRecentWorkflowRuns(tenant.id),
    ]);

    const metrics = snapshotMetrics();
    const errors = recentErrors.recent(50);
    const logs = recentLogs.recent(50);
    const aiMode = getAIMode();

    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Live platform health for this tenant. Counters, gauges, and
            histograms are read from the current Node process; recent
            workflow + AI rows come from Postgres.
          </p>
        </header>

        <div className="grid gap-6">
          <OverviewSection
            aiMode={aiMode}
            aiStats={aiStats}
            runStats={runStats}
            metrics={metrics}
          />
          <AiSection mode={aiMode} stats={aiStats} recent={recentAi} metrics={metrics} />
          <WorkflowsSection stats={runStats} recent={recentRuns} metrics={metrics} />
          <RealtimeSection metrics={metrics} />
          <LatencySection metrics={metrics} />
          <ErrorsSection errors={errors} />
          <LogsSection logs={logs} />
        </div>
      </main>
    );
  });
}
