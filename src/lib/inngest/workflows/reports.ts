import { cron } from 'inngest';
import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { runDigestsForTenant } from '@/lib/reports/manager/digest';
import { getTenantTz, markBackfillFailed, refreshLastWeek, refreshRecent, runBackfillChunk, startBackfill } from '@/lib/reports/manager/rollup';
import { addDays, localDay } from '@/lib/reports/manager/time';
import { captureError, incr } from '@/lib/observability';

import { inngest, reportBackfillRequestedEvent } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';
import { sendWorkflowEvent } from '../send';
import { eachTenant } from './each-tenant';

/**
 * Reporting workflows (build prompt 3):
 *   report-rollup-recent   every 15 min: today + yesterday (late data)
 *   report-rollup-nightly  02:00 IST: rebuild the last 7 days; first run per
 *                          tenant also queues a 400-day historical backfill
 *   report-backfill        crm/report.backfill_requested: resumable, a day at
 *                          a time, cursor committed with each day
 *   report-digests-hourly  every hour: daily (09:00) / weekly (Mon 09:00) /
 *                          saved-report digests, in each tenant's timezone
 */

const BACKFILL_DAYS = 400;
const CHUNK_DAYS = 31;
const CHUNKS_PER_RUN = 12;

async function allTenants(): Promise<Array<{ id: string; name: string }>> {
  return await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
}

export const reportRollupRecent = inngest.createFunction(
  { id: 'report-rollup-recent', name: 'Reports — rollup today + yesterday', retries: 2, concurrency: { limit: 1 }, triggers: [cron('*/15 * * * *')] },
  // One step for all tenants: Inngest bills per step, and this runs 96x a day.
  async ({ step }) =>
    step.run('recent-all', async () => {
      const list = await allTenants();
      const r = await eachTenant(
        list.map((t) => t.id),
        'reports.rollup-recent',
        (tenantId) => runWithSystemContext(tenantId, () => refreshRecent(tenantId)),
      );
      return { tenants: list.length, failed: r.failed };
    }),
);

export const reportRollupNightly = inngest.createFunction(
  { id: 'report-rollup-nightly', name: 'Reports — nightly 7-day rebuild', retries: 2, concurrency: { limit: 1 }, triggers: [cron('30 20 * * *')] },
  async ({ step }) => {
    const list = await step.run('list-tenants', allTenants);
    for (const t of list) {
      await step.run(`week-${t.id}`, () =>
        runWithSystemContext(t.id, async () => {
          await refreshLastWeek(t.id);
          const rows = (await tenantTransaction((tx) =>
            tx.execute(sql`SELECT count(*)::int AS n FROM report_backfill_jobs WHERE tenant_id = ${t.id}::uuid`),
          )) as unknown as Array<{ n: number }>;
          if (Number(rows[0]?.n ?? 0) === 0) {
            const tz = await getTenantTz(t.id);
            const today = localDay(new Date(), tz);
            const jobId = await startBackfill({ tenantId: t.id, fromDay: addDays(today, -BACKFILL_DAYS), toDay: addDays(today, -1), startedBy: null });
            await sendWorkflowEvent('crm/report.backfill_requested', { tenantId: t.id, jobId });
          }
        }),
      );
    }
    return { tenants: list.length };
  },
);

export async function reportBackfillHandler(args: { event: { data: WorkflowEvents['crm/report.backfill_requested'] }; step: LocalStepAPI }) {
  const { tenantId, jobId } = args.event.data;
  try {
    for (let i = 0; i < CHUNKS_PER_RUN; i++) {
      const r = await args.step.run(`chunk-${i}`, () => runWithSystemContext(tenantId, () => runBackfillChunk(tenantId, jobId, CHUNK_DAYS)));
      incr('reports.backfill.chunk', 1);
      if (r.done) return r;
    }
    // Long backfill: hand over to a fresh run (the cursor is in the job row).
    await args.step.run('continue', () => sendWorkflowEvent('crm/report.backfill_requested', { tenantId, jobId }));
    return { done: false };
  } catch (err) {
    captureError(err, { category: 'reports.backfill.failed', severity: 'medium', fields: { jobId } });
    await runWithSystemContext(tenantId, () => markBackfillFailed(tenantId, jobId, err instanceof Error ? err.message : String(err)));
    throw err;
  }
}

export const reportBackfill = inngest.createFunction(
  {
    id: 'report-backfill',
    name: 'Reports — historical rollup backfill',
    retries: 3,
    concurrency: { limit: 1, key: 'event.data.jobId' },
    triggers: [reportBackfillRequestedEvent],
  },
  async ({ event, step }) => reportBackfillHandler({ event, step: step as unknown as LocalStepAPI }),
);

export const reportDigestsHourly = inngest.createFunction(
  { id: 'report-digests-hourly', name: 'Reports — scheduled digests', retries: 1, concurrency: { limit: 1 }, triggers: [cron('0 * * * *')] },
  async ({ step }) => {
    const list = await step.run('list-tenants', allTenants);
    const results: Record<string, unknown> = {};
    for (const t of list) {
      results[t.id] = await step.run(`digests-${t.id}`, () => runWithSystemContext(t.id, () => runDigestsForTenant(t.id, t.name)));
    }
    return results;
  },
);
