import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { gmailConfigured } from '@/lib/email/gmail/client';
import {
  getConnectionById,
  listActiveConnectionsForTenant,
} from '@/lib/email/gmail/connections';
import { syncMailbox } from '@/lib/email/gmail/sync';
import { incr, observe, runWithTrace } from '@/lib/observability';
import { isFeatureEnabled } from '@/lib/workspace-settings/queries';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'gmail-sync';

/**
 * Every 10 minutes, sync each connected Gmail mailbox (Module 3). One cron
 * entry point that fans out per connection via `step.run` — matching the
 * stale-deals-scan per-tenant pattern, keyed per connection so a single
 * mailbox failure retries in isolation. Only workspaces with
 * EMAIL_SYNC_ENABLED and a configured OAuth client are processed.
 */
export const gmailSync = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Gmail sync — every 10 minutes',
    retries: 2,
    triggers: [cron('*/10 * * * *')],
  },
  async ({ step }) => {
    return await runWithTrace(
      { origin: 'cron', name: WORKFLOW_ID },
      async () => {
        const startedAt = Date.now();
        incr('workflow.started', 1, { workflow: WORKFLOW_ID });

        // No OAuth client configured → nothing to do (dev / unconfigured envs).
        if (!gmailConfigured()) {
          return { skipped: 'gmail_not_configured' };
        }

        const allTenants = await step.run('list-tenants', async () =>
          db.select({ id: tenants.id }).from(tenants),
        );

        let mailboxes = 0;
        for (const tenant of allTenants) {
          // Return only ids — step.run JSON-serializes its result (dropping the
          // Date fields the full connection carries), so we reload inside sync.
          const connIds = await step.run(
            `connections-${tenant.id}`,
            async () =>
              runWithSystemContext(tenant.id, async () => {
                if (!(await isFeatureEnabled(tenant.id, 'emailSyncEnabled'))) {
                  return [] as string[];
                }
                const list = await listActiveConnectionsForTenant(tenant.id);
                return list.map((c) => c.id);
              }),
          );

          for (const connId of connIds) {
            mailboxes += 1;
            await step.run(`sync-${connId}`, async () =>
              runWithSystemContext(tenant.id, async () => {
                const conn = await getConnectionById(tenant.id, connId);
                if (!conn) return { skipped: 'connection_gone' };
                const trackingId = await recordWorkflowStart({
                  tenantId: tenant.id,
                  workflowId: WORKFLOW_ID,
                  eventName: 'cron/*/10 * * * *',
                  metadata: { connectionId: conn.id, mailbox: conn.email },
                });
                try {
                  const stats = await syncMailbox(tenant.id, conn);
                  await recordWorkflowSuccess({
                    runId: trackingId,
                    metadata: { ...stats, mailbox: conn.email },
                  });
                  return stats;
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  await recordWorkflowFailure({ runId: trackingId, error: msg });
                  throw err;
                }
              }),
            );
          }
        }

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { tenants: allTenants.length, mailboxes };
      },
    );
  },
);
