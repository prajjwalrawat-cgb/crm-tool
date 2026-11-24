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
import { eachTenant } from './each-tenant';

const WORKFLOW_ID = 'gmail-sync';

/**
 * Every 15 minutes, sync each connected Gmail mailbox (Module 3). One cron
 * entry point that fans out per connection via `step.run` — matching the
 * stale-deals-scan per-tenant pattern, keyed per connection so a single
 * mailbox failure retries in isolation. Only workspaces with
 * EMAIL_SYNC_ENABLED and a configured OAuth client are processed.
 */
export const gmailSync = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Gmail sync — every 15 minutes',
    retries: 2,
    triggers: [cron('*/15 * * * *')],
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

        // One step lists every tenant's mailboxes (Inngest bills per step, so
        // a listing step per tenant cost an execution per tenant per run).
        // Return only ids: step.run JSON-serializes its result (dropping the
        // Date fields the full connection carries), so we reload inside sync.
        const byTenant = await step.run('list-connections', async () => {
          const all = await db.select({ id: tenants.id }).from(tenants);
          const r = await eachTenant(
            all.map((t) => t.id),
            'gmail-sync.list-connections',
            (tenantId) =>
              runWithSystemContext(tenantId, async () => {
                if (!(await isFeatureEnabled(tenantId, 'emailSyncEnabled'))) return [] as string[];
                const list = await listActiveConnectionsForTenant(tenantId);
                return list.map((c) => c.id);
              }),
          );
          return Object.entries(r.ok).map(([id, connIds]) => ({ id, connIds }));
        });

        let mailboxes = 0;
        // Each mailbox keeps its own step: syncing is network-bound, so it
        // needs its own request timeout and isolated retry.
        for (const tenant of byTenant) {
          for (const connId of tenant.connIds) {
            mailboxes += 1;
            await step.run(`sync-${connId}`, async () =>
              runWithSystemContext(tenant.id, async () => {
                const conn = await getConnectionById(tenant.id, connId);
                if (!conn) return { skipped: 'connection_gone' };
                const trackingId = await recordWorkflowStart({
                  tenantId: tenant.id,
                  workflowId: WORKFLOW_ID,
                  eventName: 'cron/*/15 * * * *',
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
        return { tenants: byTenant.length, mailboxes };
      },
    );
  },
);
