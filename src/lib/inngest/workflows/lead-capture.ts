import { cron } from 'inngest';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { deals, distributionRules, tenants } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { distributeLead, listLeadManagers } from '@/lib/lead-capture/distribute';
import { IMPORT_CHUNK, processImportChunk } from '@/lib/lead-capture/import';
import { processIngestEvent } from '@/lib/lead-capture/ingest';
import { notifyAssigned, retryUnassignedLeads, runSlaWatchdog } from '@/lib/lead-capture/sla';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { incr, runWithTrace } from '@/lib/observability';

import {
  inngest,
  leadCreatedEvent,
  leadImportRequestedEvent,
  leadIngestReceivedEvent,
  leadReassignRequestedEvent,
} from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI } from '../local-step';
import { sendWorkflowEvent } from '../send';
import { eachTenant } from './each-tenant';

/**
 * Lead capture workflows (build prompt 1):
 *   lead-ingest-process  crm/lead.ingest_received → map, dedupe, create → crm/lead.created
 *   lead-distribute      crm/lead.created | crm/lead.reassign_requested → assign / queue
 *   lead-sla-watchdog    every 10 min: reassign untouched leads past SLA, escalate
 *   lead-unassigned-retry every 15 min: retry the unassigned queue (up to 6h)
 *
 * Every body is idempotent: processing a processed event is a no-op, and
 * distributing an assigned lead is skipped, so Inngest retries are safe.
 */

export async function leadIngestProcessHandler(args: {
  event: { data: WorkflowEvents['crm/lead.ingest_received'] };
  step: LocalStepAPI;
}) {
  const { tenantId, eventId } = args.event.data;
  return await runWithTrace({ origin: 'workflow', name: 'lead-ingest-process' }, async () => {
    const outcome = await args.step.run('process', () =>
      runWithSystemContext(tenantId, () => processIngestEvent(eventId)),
    );
    incr('lead.ingest.outcome', 1, { status: outcome.status });

    if (outcome.status === 'created') {
      await args.step.run('emit-created', async () => {
        await sendWorkflowEvent('crm/lead.created', { tenantId, dealId: outcome.dealId, sourceId: null });
        await sendWorkflowEvent('crm/deal.created', {
          tenantId,
          dealId: outcome.dealId,
          actorUserId: null,
          name: 'Captured lead',
          stage: 'lead',
        });
      });
    } else if (outcome.status === 'duplicate') {
      await args.step.run('notify-reenquiry', () =>
        runWithSystemContext(tenantId, async () => {
          const recipients = outcome.ownerId ? [outcome.ownerId] : await listLeadManagers(tenantId);
          await recordNotificationsSafe(
            {
              tenantId,
              actorUserId: null,
              type: 'lead_assigned',
              title: outcome.reopened ? 'A lost lead enquired again and was reopened' : 'Your lead enquired again',
              subtitle: null,
              entityType: 'deal',
              entityId: outcome.dealId,
              metadata: { kind: 'lead_reenquiry' },
            },
            recipients,
          );
          if (outcome.reopened && !outcome.ownerId) {
            await sendWorkflowEvent('crm/lead.created', { tenantId, dealId: outcome.dealId, sourceId: null });
          }
        }),
      );
    }
    return outcome;
  });
}

export const leadIngestProcess = inngest.createFunction(
  {
    id: 'lead-ingest-process',
    name: 'Lead capture — process inbound payload',
    retries: 5,
    idempotency: 'event.data.eventId',
    triggers: [leadIngestReceivedEvent],
  },
  async ({ event, step }) =>
    leadIngestProcessHandler({ event, step: step as unknown as LocalStepAPI }),
);

export async function leadDistributeHandler(args: {
  event: { data: WorkflowEvents['crm/lead.created'] | WorkflowEvents['crm/lead.reassign_requested'] };
  step: LocalStepAPI;
}) {
  const { tenantId, dealId } = args.event.data;
  const exclude = 'excludeUserIds' in args.event.data ? (args.event.data.excludeUserIds ?? []) : [];
  return await runWithTrace({ origin: 'workflow', name: 'lead-distribute' }, async () => {
    const outcome = await args.step.run('distribute', () =>
      runWithSystemContext(tenantId, () => distributeLead({ tenantId, dealId, excludeUserIds: exclude })),
    );
    incr('lead.distribute.outcome', 1, { status: outcome.status });

    if (outcome.status === 'assigned') {
      await args.step.run('notify-owner', () =>
        runWithSystemContext(tenantId, async () => {
          const [d] = await tenantTransaction((tx) =>
            tx.select({ name: deals.name }).from(deals).where(eq(deals.id, dealId)),
          );
          await notifyAssigned(
            tenantId,
            { ...outcome, slaDueAt: new Date(outcome.slaDueAt) },
            d?.name ?? 'Lead',
            'New lead assigned to you',
          );
          await sendWorkflowEvent('crm/lead.assigned', {
            tenantId,
            dealId,
            userId: outcome.userId,
            ruleId: outcome.ruleId,
            slaDueAt: new Date(outcome.slaDueAt).toISOString(),
          });
        }),
      );
    } else if (outcome.status === 'unassigned') {
      await args.step.run('notify-managers', () =>
        runWithSystemContext(tenantId, async () => {
          const [d] = await tenantTransaction((tx) =>
            tx.select({ name: deals.name }).from(deals).where(eq(deals.id, dealId)),
          );
          await recordNotificationsSafe(
            {
              tenantId,
              actorUserId: null,
              type: 'lead_unassigned',
              title: `Lead needs an owner: ${d?.name ?? 'Lead'}`,
              subtitle: outcome.reason,
              entityType: 'deal',
              entityId: dealId,
            },
            await listLeadManagers(tenantId),
          );
          await sendWorkflowEvent('crm/lead.unassigned', { tenantId, dealId, reason: outcome.reason });
        }),
      );
    }
    // 'queued' (everyone off shift) is picked up by lead-unassigned-retry.
    return outcome;
  });
}

export const leadDistribute = inngest.createFunction(
  {
    id: 'lead-distribute',
    name: 'Lead capture — distribute lead',
    retries: 5,
    triggers: [leadCreatedEvent, leadReassignRequestedEvent],
  },
  async ({ event, step }) =>
    leadDistributeHandler({
      event: event as unknown as { data: WorkflowEvents['crm/lead.created'] },
      step: step as unknown as LocalStepAPI,
    }),
);

/** Tenants with at least one active distribution rule. */
async function tenantsWithRules(): Promise<string[]> {
  const all = await db.select({ id: tenants.id }).from(tenants);
  const out: string[] = [];
  for (const t of all) {
    const [r] = await runWithSystemContext(t.id, () =>
      tenantTransaction((tx) =>
        tx
          .select({ id: distributionRules.id })
          .from(distributionRules)
          .where(and(eq(distributionRules.tenantId, t.id), eq(distributionRules.isActive, true)))
          .limit(1),
      ),
    );
    if (r) out.push(t.id);
  }
  return out;
}

export const leadSlaWatchdog = inngest.createFunction(
  {
    id: 'lead-sla-watchdog',
    name: 'Lead capture — SLA watchdog',
    retries: 2,
    concurrency: { limit: 1 },
    // Every 10 min, one step for all tenants (Inngest bills per step). SLAs
    // default to 30 min, so a breach is acted on within 10 min of falling due.
    triggers: [cron('*/10 * * * *')],
  },
  async ({ step }) =>
    step.run('watchdog-all', async () => {
      const r = await eachTenant(await tenantsWithRules(), 'lead-sla-watchdog', (tenantId) =>
        runWithSystemContext(tenantId, () => runSlaWatchdog(tenantId)),
      );
      // Housekeeping: rate-limit windows older than an hour are dead weight.
      await db.execute(sql`delete from rate_limit_hits where window_start < now() - interval '1 hour'`);
      return r;
    }),
);

export const leadUnassignedRetry = inngest.createFunction(
  {
    id: 'lead-unassigned-retry',
    name: 'Lead capture — retry unassigned queue',
    retries: 2,
    concurrency: { limit: 1 },
    // Every 15 min, one step for all tenants (Inngest bills per step).
    triggers: [cron('*/15 * * * *')],
  },
  async ({ step }) =>
    step.run('retry-all', async () =>
      eachTenant(await tenantsWithRules(), 'lead-unassigned-retry', (tenantId) =>
        runWithSystemContext(tenantId, () => retryUnassignedLeads(tenantId)),
      ),
    ),
);

/**
 * CSV import: one step per chunk of IMPORT_CHUNK rows, so a retry or a
 * crashed worker resumes at the job's `processed` cursor. Created leads are
 * handed to the distributor like any other captured lead.
 */
export async function leadImportProcessHandler(args: {
  event: { data: WorkflowEvents['crm/lead.import_requested'] };
  step: LocalStepAPI;
}) {
  const { tenantId, jobId } = args.event.data;
  // Upper bound on chunks keeps a bad job from looping forever.
  for (let i = 0; i < Math.ceil(10_000 / IMPORT_CHUNK) + 1; i++) {
    const r = await args.step.run(`chunk-${i}`, () =>
      runWithSystemContext(tenantId, () => processImportChunk(tenantId, jobId)),
    );
    for (const dealId of r.createdDealIds) {
      await sendWorkflowEvent('crm/lead.created', { tenantId, dealId, sourceId: null });
    }
    if (r.done) return { chunks: i + 1 };
  }
  return { chunks: -1 };
}

export const leadImportProcess = inngest.createFunction(
  {
    id: 'lead-import-process',
    name: 'Lead capture — CSV import',
    retries: 5,
    concurrency: { limit: 1, key: 'event.data.tenantId' },
    triggers: [leadImportRequestedEvent],
  },
  async ({ event, step }) =>
    leadImportProcessHandler({ event, step: step as unknown as LocalStepAPI }),
);
