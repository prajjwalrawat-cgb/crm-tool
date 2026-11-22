import { cron } from 'inngest';

import { db } from '@/db';
import { tenants } from '@/db/schema';
import { runWithSystemContext } from '@/lib/db-context';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';
import { enrichProspect, type EnrichDeps } from '@/lib/prospects/enrich';
import { runProspectMaintenance } from '@/lib/prospects/maintenance';

import { inngest, prospectCreatedEvent } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';

const WORKFLOW_ID = 'prospects-daily-maintenance';

/**
 * Daily (02:00 IST = 20:30 UTC) Prospect Board upkeep: auto-park stale prospects
 * and release expired claims, per tenant, each gated by its own setting.
 */
export const prospectMaintenanceDaily = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Prospects — daily auto-park and claim expiry',
    retries: 2,
    triggers: [cron('30 20 * * *')],
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

        const results: Array<{ tenantId: string; parked: number; released: number }> = [];
        for (const tenant of allTenants) {
          const r = await step.run(`maintenance-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => prospectMaintenanceHandler(tenant.id)),
          );
          results.push({ tenantId: tenant.id, ...r });
        }

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, { workflow: WORKFLOW_ID });
        return { tenants: allTenants.length, results };
      },
    );
  },
);

/** Plain handler for one tenant (exported for tests). */
export async function prospectMaintenanceHandler(
  tenantId: string,
  now?: Date,
): Promise<{ parked: number; released: number }> {
  try {
    const r = await runProspectMaintenance(tenantId, now);
    incr('prospects.auto_parked', r.parked, { workflow: WORKFLOW_ID });
    incr('prospects.claims_expired', r.released, { workflow: WORKFLOW_ID });
    return r;
  } catch (err) {
    captureError(err, {
      category: 'workflow.prospects-daily-maintenance',
      severity: 'high',
      retryable: true,
      fields: { tenantId },
    });
    incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
    throw err;
  }
}

/* ---------------- AI enrichment (crm/prospect.created) ---------------- */

/**
 * Suggests industry / size band / product fit / ICP score for a new prospect
 * into the AI suggestions queue. Gated (and idempotent) inside
 * enrichProspect. A retryable model error throws so Inngest retries with
 * backoff (the failed claim can be re-taken). Never writes a prospect field.
 */
export async function prospectEnrichHandler(
  args: { event: { data: WorkflowEvents['crm/prospect.created'] }; step: LocalStepAPI },
  deps: EnrichDeps = {},
) {
  const { tenantId, prospectId } = args.event.data;
  return await runWithTrace({ origin: 'workflow', name: 'prospect-enrich' }, async () => {
    const r = await args.step.run('enrich', () => runWithSystemContext(tenantId, () => enrichProspect(tenantId, prospectId, deps)));
    incr('prospects.enrich.run', 1, { status: r.status });
    if (r.status === 'failed' && r.retryable) throw new Error(`prospect-enrich: ${r.error}`);
    return r;
  });
}

export const prospectEnrich = inngest.createFunction(
  {
    id: 'prospect-enrich',
    name: 'Prospects — AI enrichment',
    retries: 2,
    concurrency: { limit: 5 },
    triggers: [prospectCreatedEvent],
  },
  async ({ event, step }) => prospectEnrichHandler({ event, step: step as unknown as LocalStepAPI }),
);
