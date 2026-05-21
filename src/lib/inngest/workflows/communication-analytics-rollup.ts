import { cron } from 'inngest';
import { sql } from 'drizzle-orm';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { inngest } from '../client';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'communication-analytics-rollup';

/**
 * Nightly cron at 02:00 UTC. Walks every tenant and UPSERTs the
 * canonical per-day metrics into `communication_analytics`. The
 * inbox + executive dashboards read from this rollup table rather
 * than aggregating events on every render.
 *
 * Metrics computed per tenant for today's UTC date:
 *   - sent_count
 *   - delivered_count
 *   - failed_count
 *   - retry_count
 *   - replied_count
 *   - bounced_count
 *   - success_rate     (sent / total attempts, 0..1)
 *   - bounce_rate      (bounced / sent, 0..1)
 *
 * Each tenant is its own retryable step so a transient failure on
 * one doesn't block the rest.
 */
export const communicationAnalyticsRollup = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Communication analytics — daily rollup',
    retries: 2,
    triggers: [cron('0 2 * * *')],
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

        const results: Array<{ tenantId: string; metricsWritten: number }> = [];
        for (const tenant of allTenants) {
          const metrics = await step.run(`rollup-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => rollupTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, metricsWritten: metrics });
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
 * Per-tenant rollup. Single SQL aggregate over `communication_events`
 * for the current UTC day, then UPSERTs one row per metric_name.
 */
async function rollupTenant(tenantId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const dayStart = `${today}T00:00:00.000Z`;
  const dayEnd = `${today}T23:59:59.999Z`;

  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 2 * * *',
    metadata: { day: today },
  });

  try {
    type AggregateRow = {
      sent: number;
      delivered: number;
      failed: number;
      retried: number;
      replied: number;
      bounced: number;
    };
    const rows = (await tenantTransaction(async (tx) =>
      tx.execute(sql`
        SELECT
          count(*) FILTER (WHERE event_kind = 'sent')::int      AS sent,
          count(*) FILTER (WHERE event_kind = 'delivered')::int AS delivered,
          count(*) FILTER (WHERE event_kind = 'failed')::int    AS failed,
          count(*) FILTER (WHERE event_kind = 'retried')::int   AS retried,
          count(*) FILTER (WHERE event_kind = 'replied')::int   AS replied,
          count(*) FILTER (WHERE event_kind = 'bounced')::int   AS bounced
        FROM communication_events
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= ${dayStart}::timestamptz
          AND created_at <= ${dayEnd}::timestamptz
      `),
    )) as unknown as AggregateRow[];
    const a = rows[0] ?? {
      sent: 0,
      delivered: 0,
      failed: 0,
      retried: 0,
      replied: 0,
      bounced: 0,
    };

    const sentAttempts = a.sent + a.failed + a.retried;
    const successRate = sentAttempts === 0 ? 0 : a.sent / sentAttempts;
    const bounceRate = a.sent === 0 ? 0 : a.bounced / a.sent;

    const metrics: Array<{ name: string; value: number }> = [
      { name: 'sent_count', value: a.sent },
      { name: 'delivered_count', value: a.delivered },
      { name: 'failed_count', value: a.failed },
      { name: 'retry_count', value: a.retried },
      { name: 'replied_count', value: a.replied },
      { name: 'bounced_count', value: a.bounced },
      { name: 'success_rate', value: successRate },
      { name: 'bounce_rate', value: bounceRate },
    ];

    await tenantTransaction(async (tx) => {
      for (const m of metrics) {
        await tx.execute(sql`
          INSERT INTO communication_analytics
            (tenant_id, metric_day, metric_name, metric_value)
          VALUES (${tenantId}::uuid, ${today}::date, ${m.name}, ${m.value})
          ON CONFLICT (tenant_id, metric_day, metric_name)
          DO UPDATE SET metric_value = EXCLUDED.metric_value
        `);
      }
    });

    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { day: today, metricsWritten: metrics.length, ...a },
    });

    return metrics.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError(err, {
      category: 'workflow.communication-analytics-rollup',
      severity: 'medium',
      retryable: true,
      fields: { tenantId },
    });
    incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
