import { and, eq, isNull, lt, ne } from 'drizzle-orm';

import { db } from '@/db';
import { deals, tenants } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { inngest } from '../client';
import { cron } from 'inngest';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'stale-deals-scan';

/** A deal is stale if it hasn't been touched in this many days and isn't won/lost. */
const STALE_THRESHOLD_DAYS = 14;

/**
 * Daily cron at 09:00 UTC. Scans every tenant for deals whose `updated_at`
 * is older than the threshold and which haven't reached a closed stage,
 * then writes one `automation_note` activity per stale deal.
 *
 * The cron entry point fans the work out per-tenant via `step.run` so each
 * tenant's scan is its own retryable unit — a transient failure on one
 * tenant doesn't block the rest.
 */
export const staleDealsScan = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Stale deals — daily scan',
    retries: 2,
    triggers: [cron('0 9 * * *')],
  },
  async ({ step }) => {
    return await runWithTrace(
      { origin: 'cron', name: WORKFLOW_ID },
      async () => {
        const startedAt = Date.now();
        incr('workflow.started', 1, { workflow: WORKFLOW_ID });

        // The tenants table is intentionally not RLS-scoped (chicken-and
        // -egg for context), so this read runs as the connection role.
        const allTenants = await step.run('list-tenants', async () =>
          db.select({ id: tenants.id, name: tenants.name }).from(tenants),
        );

        const results: Array<{ tenantId: string; flagged: number }> = [];

        for (const tenant of allTenants) {
          // Each tenant scan is its own step, so retries can target a
          // single tenant rather than re-running the whole world.
          const flagged = await step.run(`scan-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => scanTenant(tenant.id)),
          );
          results.push({ tenantId: tenant.id, flagged });
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

async function scanTenant(tenantId: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  // Record-keeping row first so the admin UI shows the scan even if the
  // body short-circuits.
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 9 * * *',
    metadata: { cutoff: cutoff.toISOString(), thresholdDays: STALE_THRESHOLD_DAYS },
  });

  try {
    const stale = await tenantTransaction(async (tx) =>
      tx
        .select({
          id: deals.id,
          name: deals.name,
          stage: deals.stage,
          updatedAt: deals.updatedAt,
        })
        .from(deals)
        .where(
          and(
            eq(deals.tenantId, tenantId),
            isNull(deals.deletedAt),
            ne(deals.stage, 'won'),
            ne(deals.stage, 'lost'),
            lt(deals.updatedAt, cutoff),
          ),
        ),
    );

    for (const deal of stale) {
      // recordActivity opens its own tenantTransaction; we're already in
      // a system context so the GUC propagates.
      const days = Math.round(
        (Date.now() - deal.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      await recordActivity(db, {
        tenantId,
        actorUserId: null,
        entityType: 'deal',
        entityId: deal.id,
        action: 'automation_note',
        metadata: {
          message: `Deal "${deal.name}" hasn't moved in ${days} days — nudge the owner.`,
          workflow: WORKFLOW_ID,
          kind: 'stale',
          daysSinceUpdate: days,
        },
      });
    }

    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: {
        flagged: stale.length,
        thresholdDays: STALE_THRESHOLD_DAYS,
      },
    });

    return stale.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError(err, {
      category: 'workflow.stale-deals-scan',
      severity: 'high',
      retryable: true,
      fields: { tenantId },
    });
    incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
