import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { captureForecastSnapshot } from '@/lib/deals/forecast/snapshots';
import { resolvePeriod } from '@/lib/deals/forecast/period';
import { getForecastRollup } from '@/lib/deals/forecast/rollup';
import { resolveStageProbabilities } from '@/lib/deals/stage-probability';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { incr, observe, runWithTrace } from '@/lib/observability';
import { isFeatureEnabled } from '@/lib/workspace-settings/queries';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'forecast-snapshot-weekly';

/**
 * Weekly forecast snapshot. Runs Monday 00:30 IST — that's Sunday 19:00 UTC
 * (IST = UTC+5:30), expressed in plain UTC per the repo's cron convention.
 * Snapshots the CURRENT quarter's rollup per flag-on tenant so week-over-week
 * movement can be charted and a "vs last week" delta shown.
 */
export const forecastSnapshotWeekly = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Forecast — weekly snapshot',
    retries: 2,
    // Monday 00:30 IST == Sunday 19:00 UTC.
    triggers: [cron('0 19 * * 0')],
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

        const results: Array<{ tenantId: string; rows: number }> = [];
        for (const tenant of allTenants) {
          const rows = await step.run(`snapshot-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => snapshotTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, rows });
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

async function snapshotTenant(tenantId: string): Promise<number> {
  if (!(await isFeatureEnabled(tenantId, 'forecastsEnabled'))) return 0;

  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 19 * * 0',
    metadata: {},
  });
  try {
    const settings = await getOrgSettings(tenantId);
    const now = new Date();
    const period = resolvePeriod(
      'quarter',
      null,
      now,
      settings.fiscalYearStartMonth ?? 1,
    );
    const probabilities = resolveStageProbabilities(settings.stageProbabilities);
    const rollup = await getForecastRollup({
      tenantId,
      startISO: period.startISO,
      endISO: period.endISO,
      probabilities,
    });
    const rows = await captureForecastSnapshot(tenantId, period.key, rollup);
    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { period: period.key, rows },
    });
    return rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: msg });
    throw err;
  }
}
