import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { recomputeOpenDealsForTenant } from '@/lib/deals/scoring/service';
import { incr, observe, runWithTrace } from '@/lib/observability';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

import { inngest } from '../client';

const WORKFLOW_ID = 'deal-scores-nightly';

/**
 * Nightly cron (01:00 UTC) that recomputes the health score of every open deal
 * in every workspace with DEAL_SCORING_ENABLED on. Fans out per-tenant via
 * `step.run` so one tenant's failure is retried in isolation.
 * `recomputeOpenDealsForTenant` short-circuits for flag-off tenants.
 */
export const dealScoresNightly = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Deal scores — nightly recompute',
    retries: 2,
    triggers: [cron('0 1 * * *')],
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

        const results: Array<{ tenantId: string; scored: number }> = [];
        for (const tenant of allTenants) {
          const scored = await step.run(`score-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => scoreTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, scored });
        }

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { tenants: allTenants.length, results };
      },
    );
  },
);

async function scoreTenant(tenantId: string): Promise<number> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 1 * * *',
    metadata: {},
  });
  try {
    const { scored } = await recomputeOpenDealsForTenant(tenantId);
    await recordWorkflowSuccess({ runId: trackingId, metadata: { scored } });
    return scored;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
