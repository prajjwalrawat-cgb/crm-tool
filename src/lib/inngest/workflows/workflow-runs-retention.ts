import { and, eq, lt, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { workflowRuns, tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { inngest } from '../client';
import { cron } from 'inngest';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'workflow-runs-retention';

/**
 * `workflow_runs` is append-only and grows indefinitely — the
 * regenerate-embedding workflow alone writes a row per CRUD action,
 * including a 'skipped' row when the SHA-256 hash matched. With high
 * mutation volume the table accumulates rows that no operator looks
 * at after a week. This cron sweeps both terminal and intermediate
 * old rows on a per-tenant basis, capping growth without losing the
 * recent operational signal.
 *
 * Retention windows (intentionally generous):
 *   - skipped runs: 7 days  (noisy, low operational value)
 *   - completed runs: 30 days
 *   - failed runs:    90 days (kept longest for post-mortem)
 *   - running rows older than 24h are also dropped — they're orphans
 *     from a crashed Node process or an Inngest function that died
 *     mid-flight; leaving them in the table makes the workflows page
 *     look like jobs are still in flight.
 *
 * Per-tenant scan to keep transactions small. Counts are recorded as
 * counter metrics + a skipped/success workflow_runs entry so the
 * sweep itself is observable.
 */
const RETENTION_DAYS = {
  skipped: 7,
  completed: 30,
  failed: 90,
  // Anything still "running" past this window is almost certainly a
  // crashed run we'll never resume.
  runningOrphan: 1,
} as const;

export const workflowRunsRetention = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Workflow runs — daily retention sweep',
    retries: 1,
    triggers: [cron('15 9 * * *')],
  },
  async ({ step }) => {
    return await runWithTrace(
      { origin: 'cron', name: WORKFLOW_ID },
      async () => {
        const startedAt = Date.now();
        incr('workflow.started', 1, { workflow: WORKFLOW_ID });

        const allTenants = await step.run('list-tenants', async () =>
          db.select({ id: tenants.id, name: tenants.name }).from(tenants),
        );

        const totals = { skipped: 0, completed: 0, failed: 0, orphans: 0 };

        for (const tenant of allTenants) {
          const result = await step.run(`prune-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => pruneTenant(tenant.id)),
          );
          totals.skipped += result.skipped;
          totals.completed += result.completed;
          totals.failed += result.failed;
          totals.orphans += result.orphans;
        }

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { tenants: allTenants.length, ...totals };
      },
    );
  },
);

async function pruneTenant(tenantId: string): Promise<{
  skipped: number;
  completed: number;
  failed: number;
  orphans: number;
}> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/15 9 * * *',
    metadata: { thresholds: RETENTION_DAYS },
  });

  try {
    const now = Date.now();
    const cutoffSkipped = new Date(now - RETENTION_DAYS.skipped * 86400_000);
    const cutoffCompleted = new Date(now - RETENTION_DAYS.completed * 86400_000);
    const cutoffFailed = new Date(now - RETENTION_DAYS.failed * 86400_000);
    const cutoffOrphan = new Date(now - RETENTION_DAYS.runningOrphan * 86400_000);

    // System-maintenance op: run as the connection role (postgres) so
    // we bypass RLS. The migration deliberately doesn't grant DELETE on
    // workflow_runs to app_user — there's no app code path that mutates
    // history. Each DELETE here still narrows by `tenant_id` explicitly.
    const skippedRes = (await db.execute(
      sql`DELETE FROM workflow_runs
          WHERE tenant_id = ${tenantId}::uuid
            AND status = 'skipped'
            AND started_at < ${cutoffSkipped.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const completedRes = (await db.execute(
      sql`DELETE FROM workflow_runs
          WHERE tenant_id = ${tenantId}::uuid
            AND status = 'completed'
            AND started_at < ${cutoffCompleted.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const failedRes = (await db.execute(
      sql`DELETE FROM workflow_runs
          WHERE tenant_id = ${tenantId}::uuid
            AND status = 'failed'
            AND started_at < ${cutoffFailed.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const orphanRes = (await db.execute(
      sql`DELETE FROM workflow_runs
          WHERE tenant_id = ${tenantId}::uuid
            AND status = 'running'
            AND started_at < ${cutoffOrphan.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const counts = {
      skipped: skippedRes.length,
      completed: completedRes.length,
      failed: failedRes.length,
      orphans: orphanRes.length,
    };

    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { ...counts, thresholds: RETENTION_DAYS },
    });
    incr('workflow_retention.pruned', counts.skipped, { kind: 'skipped' });
    incr('workflow_retention.pruned', counts.completed, { kind: 'completed' });
    incr('workflow_retention.pruned', counts.failed, { kind: 'failed' });
    incr('workflow_retention.pruned', counts.orphans, { kind: 'orphan' });

    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError(err, {
      category: 'workflow.workflow-runs-retention',
      severity: 'medium',
      retryable: true,
      fields: { tenantId },
    });
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}

// Exposed so a manual operator script can invoke the same logic
// without waiting for the cron tick. Used by selftest-workflows and
// scripts/prune-workflow-runs.ts. Wraps in a system context so the
// nested `recordWorkflowStart` / `tenantTransaction` calls work — the
// cron path enters this context per-tenant via `runWithSystemContext`.
export async function pruneTenantRetention(tenantId: string) {
  return await runWithSystemContext(tenantId, () => pruneTenant(tenantId));
}

// Eliminate unused warning when imports survive a refactor.
void or;
void and;
void eq;
void lt;
void workflowRuns;
