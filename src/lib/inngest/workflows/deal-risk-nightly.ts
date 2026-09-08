import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { recomputeTenantRisk } from '@/lib/deals/risk/runner';
import { incr, observe, runWithTrace } from '@/lib/observability';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'deal-risk-nightly';
const CRON_EXPRESSION = '30 1 * * *';

/**
 * Nightly deal risk pass (Phase 1). 01:30 UTC, half an hour after
 * `deal-scores-nightly` so the two scoring jobs do not contend for the same
 * connections — and in that order deliberately, since risk reads the stage
 * medians the health score's service resolves.
 *
 * Scores are written for every open deal every night regardless of change:
 * the arithmetic is cheap and "days since last touch" moves on its own, so a
 * deal that nobody edited still crosses a threshold eventually. The LLM
 * explanation is the expensive half and is regenerated only when the deal's
 * signals actually change band — see `@/lib/deals/risk/hash`.
 *
 * Per-tenant failures are isolated. One workspace with a broken key must not
 * stop the other twenty from being scored.
 */
export const dealRiskNightly = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Deals — nightly risk score',
    retries: 2,
    triggers: [cron(CRON_EXPRESSION)],
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

        const results: Array<{ tenantId: string; scored: number; explained: number }> =
          [];
        for (const tenant of allTenants) {
          const outcome = await step.run(`risk-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => scoreTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, ...outcome });
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

/**
 * Score one tenant. Exported so the manual script runs the identical path —
 * a score produced by a second code path is not the same score.
 */
export async function scoreTenant(
  tenantId: string,
): Promise<{ scored: number; explained: number }> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: `cron/${CRON_EXPRESSION}`,
    metadata: {},
  });
  try {
    const result = await recomputeTenantRisk(tenantId);
    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: {
        scored: result.scored,
        pruned: result.pruned,
        explained: result.explained,
        deferred: result.deferred,
        explainerAvailable: result.explainerAvailable,
      },
    });
    return { scored: result.scored, explained: result.explained };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: msg });
    throw err;
  }
}
