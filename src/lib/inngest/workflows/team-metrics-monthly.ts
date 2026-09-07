import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import { incr, observe, runWithTrace } from '@/lib/observability';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { currentFiscalYear } from '@/lib/targets/fiscal';
import {
  captureTeamMetrics,
  periodKey,
  previousPeriodKey,
} from '@/lib/team-analytics/snapshots';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'team-metrics-monthly';
const CRON_EXPRESSION = '20 0 1 * *';

/**
 * Month-close snapshot of the Team Performance scorecard. Runs at 00:20 UTC
 * on the 1st and captures the month that has just ENDED, which is what every
 * "vs last month" delta on `/dashboard/team-performance` reads.
 *
 * Period-close rather than daily: the page compares against the last closed
 * month, so 29 extra rows per rep per metric would answer a question nobody
 * asks. Re-running is safe — `captureTeamMetrics` upserts on
 * (tenant, metric, rep, period), so a retry overwrites rather than doubles.
 *
 * WHICH FISCAL YEAR gets captured is derived from a moment INSIDE the period
 * being snapshotted, not from `now`. On the 1st of a fiscal year's first
 * month those two disagree, and using `now` would file the new (empty) year's
 * figures under the old year's final month — a 100% collapse appearing in
 * every delta on the page, once a year, for a whole month.
 */
export const teamMetricsMonthly = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Team performance — month-close snapshot',
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
          db.select({ id: tenants.id, name: tenants.name }).from(tenants),
        );

        const results: Array<{ tenantId: string; rows: number }> = [];
        for (const tenant of allTenants) {
          const rows = await step.run(`snapshot-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () =>
              snapshotTenant(tenant.id, tenant.name, new Date()),
            ),
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

/**
 * Capture one tenant. Exported so the manual backfill script
 * (`pnpm snapshot:team-metrics`) runs exactly the same path the cron does —
 * a baseline written by a second implementation is not a baseline.
 */
export async function snapshotTenant(
  tenantId: string,
  tenantName: string,
  now: Date,
  periodOverride?: string,
): Promise<number> {
  const period = periodOverride ?? previousPeriodKey(periodKey(now));
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: `cron/${CRON_EXPRESSION}`,
    metadata: { period },
  });
  try {
    const settings = await getOrgSettings(tenantId);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    // Mid-month of the period being captured — see the note above about the
    // fiscal-year boundary.
    const insidePeriod = new Date(`${period}-15T00:00:00.000Z`);
    const fiscalYear = currentFiscalYear(startMonth, insidePeriod);
    const rows = await captureTeamMetrics(
      tenantId,
      tenantName,
      fiscalYear,
      startMonth,
      now,
      period,
    );
    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { period, fiscalYear, rows },
    });
    return rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordWorkflowFailure({ runId: trackingId, error: msg });
    throw err;
  }
}
