import { cron } from 'inngest';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db';
import { incentivePlans, tenants } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { recomputePlanActuals } from '@/lib/incentives/actuals-compute';
import { incr, observe, runWithTrace } from '@/lib/observability';
import { getOrgSettings } from '@/lib/org-settings/queries';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'incentive-actuals-nightly';
const CRON_EXPRESSION = '40 1 * * *';

/**
 * Nightly recompute of incentive actuals from deal data, for every ACTIVE
 * plan whose actuals source is 'computed'. Plans on manual actuals are left
 * alone — the job never writes over, or competes with, an entered figure.
 *
 * Idempotent: each plan gets one computed row per day (upsert on
 * plan + as_of_date), and each row is a full recomputation rather than an
 * increment, so a retry or a manual "Recompute now" on the same day replaces
 * the figure instead of adding to it.
 */
export const incentiveActualsNightly = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Incentives — nightly computed actuals',
    retries: 2,
    triggers: [cron(CRON_EXPRESSION)],
  },
  async ({ step }) => {
    return await runWithTrace({ origin: 'cron', name: WORKFLOW_ID }, async () => {
      const startedAt = Date.now();
      incr('workflow.started', 1, { workflow: WORKFLOW_ID });

      const allTenants = await step.run('list-tenants', async () =>
        db.select({ id: tenants.id }).from(tenants),
      );

      const results: Array<{ tenantId: string; plans: number }> = [];
      for (const tenant of allTenants) {
        const plans = await step.run(`recompute-${tenant.id}`, async () =>
          runWithSystemContext(tenant.id, () => recomputeTenant(tenant.id, new Date())),
        );
        results.push({ tenantId: tenant.id, plans });
      }

      incr('workflow.success', 1, { workflow: WORKFLOW_ID });
      observe('workflow.duration_ms', Date.now() - startedAt, { workflow: WORKFLOW_ID });
      return { tenants: allTenants.length, results };
    });
  },
);

/**
 * Recompute every eligible plan in one tenant. Exported so the admin
 * "Recompute now" action runs exactly the path the cron does.
 */
export async function recomputeTenant(
  tenantId: string,
  now: Date,
  opts: { planIds?: string[] } = {},
): Promise<number> {
  const plans = await tenantTransaction((tx) =>
    tx
      .select({ id: incentivePlans.id, userId: incentivePlans.userId, fiscalYear: incentivePlans.fiscalYear })
      .from(incentivePlans)
      .where(
        and(
          eq(incentivePlans.tenantId, tenantId),
          eq(incentivePlans.status, 'active'),
          eq(incentivePlans.actualsSource, 'computed'),
          opts.planIds ? inArray(incentivePlans.id, opts.planIds) : undefined,
        ),
      ),
  );
  if (plans.length === 0) return 0;

  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: `cron/${CRON_EXPRESSION}`,
    metadata: { plans: plans.length },
  });
  try {
    const settings = await getOrgSettings(tenantId);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    for (const plan of plans) {
      await recomputePlanActuals(tenantId, plan, startMonth, now);
    }
    await recordWorkflowSuccess({ runId: trackingId, metadata: { plans: plans.length } });
    return plans.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: msg });
    throw err;
  }
}
