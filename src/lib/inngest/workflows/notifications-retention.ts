import { sql } from 'drizzle-orm';
import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { incr, observe, runWithTrace } from '@/lib/observability';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'notifications-retention';

/**
 * Daily prune of the notifications table. Read notifications age out
 * faster than unread ones (operators don't go back to dismissed
 * alerts); unread notifications survive longer because they may
 * still represent unhandled work.
 *
 * Retention windows:
 *   - read notifications:    30 days
 *   - unread notifications:  90 days
 *
 * Same per-tenant pattern + bypass-RLS via the connection role as
 * `workflow-runs-retention`. Notifications have a per-recipient RLS
 * policy that would block a single global DELETE, so we scope by
 * tenant_id explicitly and rely on the connection running as
 * postgres (table owner) — RLS is forced on, but the app_user role
 * doesn't have a DELETE policy that fires here because the cron
 * runs from a system context, not an authenticated request.
 */
const RETENTION_DAYS = {
  read: 30,
  unread: 90,
} as const;

export const notificationsRetention = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Notifications — daily retention sweep',
    retries: 1,
    triggers: [cron('45 9 * * *')],
  },
  async ({ step }) => {
    return await runWithTrace(
      { origin: 'cron', name: WORKFLOW_ID },
      async () => {
        const startedAt = Date.now();
        incr('workflow.started', 1, { workflow: WORKFLOW_ID });

        const allTenants = await step.run('list-tenants', async () =>
          db.select({ id: tenants.id }).from(tenants),
        );

        const totals = { read: 0, unread: 0 };

        for (const tenant of allTenants) {
          const result = await step.run(`prune-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => pruneTenant(tenant.id)),
          );
          totals.read += result.read;
          totals.unread += result.unread;
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

async function pruneTenant(
  tenantId: string,
): Promise<{ read: number; unread: number }> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/45 9 * * *',
    metadata: { thresholds: RETENTION_DAYS },
  });

  try {
    const now = Date.now();
    const cutoffRead = new Date(now - RETENTION_DAYS.read * 86400_000);
    const cutoffUnread = new Date(now - RETENTION_DAYS.unread * 86400_000);

    const readRes = (await db.execute(
      sql`DELETE FROM notifications
          WHERE tenant_id = ${tenantId}::uuid
            AND read_at IS NOT NULL
            AND created_at < ${cutoffRead.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const unreadRes = (await db.execute(
      sql`DELETE FROM notifications
          WHERE tenant_id = ${tenantId}::uuid
            AND read_at IS NULL
            AND created_at < ${cutoffUnread.toISOString()}
          RETURNING id`,
    )) as unknown as Array<{ id: string }>;

    const counts = { read: readRes.length, unread: unreadRes.length };
    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: counts,
    });
    incr('notifications.pruned.read', counts.read, { tenantId });
    incr('notifications.pruned.unread', counts.unread, { tenantId });
    return counts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
