import { cron } from 'inngest';
import { sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  relationshipSignals,
  tenants,
  type RelationshipStatus,
} from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { computeBreakdownFromSignal } from '@/lib/communications/relationships/score';
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

const WORKFLOW_ID = 'relationship-signals-derive';

/**
 * Daily cron at 04:00 UTC. For each tenant, walks every row in
 * `relationship_signals`, recomputes `silent_days` from the latest
 * inbound/outbound timestamps, re-derives the score + status, and
 * UPSERTs.
 *
 * The send pipeline keeps counters fresh on the hot path; this job
 * exists for two purposes the hot path can't cover:
 *   1. Decay — `silent_days` increments naturally with the clock,
 *      not just on writes. Without this job, a row that hasn't seen
 *      a send in 90 days still reports `silent_days = 0`.
 *   2. Score re-derivation — the formula evolves; nightly refresh
 *      keeps the cached `score` + `status` in sync with the latest
 *      `computeBreakdownFromSignal` implementation.
 */
export const relationshipSignalsDerive = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Relationship signals — daily derive',
    retries: 2,
    triggers: [cron('0 4 * * *')],
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

        const results: Array<{ tenantId: string; updated: number }> = [];
        for (const tenant of allTenants) {
          const updated = await step.run(`derive-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => deriveTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, updated });
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

async function deriveTenant(tenantId: string): Promise<number> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 4 * * *',
    metadata: {},
  });

  try {
    // Walk every signal row. At realistic scale (thousands of
    // entities per tenant) the full scan is cheap; if a tenant
    // pushes past 100k entities we add a windowed walk.
    const rows = await tenantTransaction(async (tx) =>
      tx.select().from(relationshipSignals),
    );

    const now = Date.now();
    let updated = 0;

    for (const row of rows) {
      // Recompute silent_days from the latest bi-directional contact.
      const latest = Math.max(
        row.lastInboundAt?.getTime() ?? 0,
        row.lastOutboundAt?.getTime() ?? 0,
      );
      const silentDays =
        latest === 0
          ? 365
          : Math.max(0, Math.floor((now - latest) / (24 * 60 * 60 * 1000)));

      // Re-derive score + status with the fresh silent_days.
      const refreshed = computeBreakdownFromSignal({
        ...row,
        silentDays,
      });

      const status: RelationshipStatus = refreshed.status;

      // Skip writes when nothing has changed (small but adds up across
      // thousands of rows).
      if (
        row.silentDays === silentDays &&
        Math.abs((row.score ?? 0) - refreshed.score) < 0.001 &&
        row.status === status
      ) {
        continue;
      }

      await tenantTransaction(async (tx) =>
        tx.execute(sql`
          UPDATE relationship_signals
          SET silent_days = ${silentDays},
              score       = ${refreshed.score},
              status      = ${status},
              updated_at  = now()
          WHERE tenant_id = ${tenantId}::uuid AND id = ${row.id}::uuid
        `),
      );
      updated++;
    }

    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { total: rows.length, updated },
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError(err, {
      category: 'workflow.relationship-signals-derive',
      severity: 'medium',
      retryable: true,
      fields: { tenantId },
    });
    incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
