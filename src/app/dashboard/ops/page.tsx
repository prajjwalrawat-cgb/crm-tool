import { redirect } from 'next/navigation';

import { getAIMode } from '@/lib/ai/config';
import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import {
  getAiInvocationStats,
  getEmailDeliveryStats,
  getRecentAiInvocations,
  getRecentWorkflowRuns,
  getWorkflowStats,
} from '@/lib/ops/queries';
import { recentErrors, recentLogs, snapshotMetrics } from '@/lib/observability';
import { can } from '@/lib/rbac';

import { AiSection } from './_components/ai-section';
import { AutomationHealthSection } from './_components/automation-health-section';
import { EmailSection } from './_components/email-section';
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

    const [aiStats, recentAi, runStats, recentRuns, emailStats] =
      await Promise.all([
        getAiInvocationStats(tenant.id, 24),
        getRecentAiInvocations(tenant.id),
        getWorkflowStats(tenant.id, 24),
        getRecentWorkflowRuns(tenant.id),
        getEmailDeliveryStats(tenant.id, 24),
      ]);

    const metrics = snapshotMetrics();
    const errors = recentErrors.recent(50);
    const logs = recentLogs.recent(50);
    const aiMode = getAIMode();

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Operations</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
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
          <AutomationHealthSection
            errors={errors}
            runStats={runStats}
            emailStats={emailStats}
          />
          <AiSection mode={aiMode} stats={aiStats} recent={recentAi} metrics={metrics} />
          <WorkflowsSection stats={runStats} recent={recentRuns} metrics={metrics} />
          <EmailSection stats={emailStats} />
          <RealtimeSection metrics={metrics} />
          <LatencySection metrics={metrics} />
          <ErrorsSection errors={errors} />
          <LogsSection logs={logs} />
        </div>
      </main>
    );
  });
}
