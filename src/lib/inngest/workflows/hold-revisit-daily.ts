import { cron } from 'inngest';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { deals, tasks, tenants } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { HOLD_REASON_LABELS, type HoldReason } from '@/lib/deals/hold';
import { recordNotificationSafe } from '@/lib/notifications/recorder';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

import { inngest } from '../client';

const WORKFLOW_ID = 'hold-revisit-daily';

/**
 * Daily (08:00 UTC) scan for held deals whose "revisit on" date has arrived
 * (Module 6). For each, create a task for the deal owner — unless an open
 * revisit task already exists, so re-running is idempotent. The deals also show
 * up under the pipeline's "Revisit due" filter.
 */
export const holdRevisitDaily = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Hold — daily revisit-due scan',
    retries: 2,
    triggers: [cron('0 8 * * *')],
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

        const results: Array<{ tenantId: string; created: number }> = [];
        for (const tenant of allTenants) {
          const created = await step.run(`revisit-${tenant.id}`, async () =>
            runWithSystemContext(tenant.id, () => runHoldRevisitScan(tenant.id)),
          );
          results.push({ tenantId: tenant.id, created });
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
 * Create revisit tasks for a tenant's due held deals. Exported for the selftest;
 * must run inside a tenant/system context.
 */
export async function runHoldRevisitScan(tenantId: string): Promise<number> {
  const trackingId = await recordWorkflowStart({
    tenantId,
    workflowId: WORKFLOW_ID,
    eventName: 'cron/0 8 * * *',
    metadata: {},
  });
  try {
    const due = await tenantTransaction((tx) =>
      tx
        .select({
          id: deals.id,
          name: deals.name,
          ownerId: deals.ownerId,
          holdReason: deals.holdReason,
          holdRevisitOn: deals.holdRevisitOn,
        })
        .from(deals)
        .where(
          and(
            eq(deals.tenantId, tenantId),
            isNull(deals.deletedAt),
            eq(deals.stage, 'hold'),
            sql`${deals.holdRevisitOn} IS NOT NULL AND ${deals.holdRevisitOn} <= CURRENT_DATE`,
          ),
        ),
    );

    let created = 0;
    for (const deal of due) {
      const madeTask = await tenantTransaction(async (tx) => {
        // Idempotency: skip if an open revisit task already exists for this deal.
        const [existing] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.tenantId, tenantId),
              eq(tasks.entityType, 'deal'),
              eq(tasks.entityId, deal.id),
              isNull(tasks.deletedAt),
              sql`${tasks.status} NOT IN ('completed','cancelled')`,
              sql`${tasks.title} LIKE 'Revisit held deal%'`,
            ),
          )
          .limit(1);
        if (existing) return false;

        const reasonLabel = deal.holdReason
          ? HOLD_REASON_LABELS[deal.holdReason as HoldReason] ?? deal.holdReason
          : 'unknown reason';
        const [task] = await tx
          .insert(tasks)
          .values({
            tenantId,
            title: `Revisit held deal: ${deal.name}`,
            description: `This deal was parked on Hold (${reasonLabel}). Its revisit date has arrived — decide whether to reactivate, re-forecast, or close it.`,
            status: 'todo',
            priority: 'high',
            dueDate: deal.holdRevisitOn,
            assignedUserId: deal.ownerId,
            createdBy: 'system',
            entityType: 'deal',
            entityId: deal.id,
          })
          .returning({ id: tasks.id });
        if (!task) return false;

        await recordActivity(tx, {
          tenantId,
          actorUserId: null,
          entityType: 'deal',
          entityId: deal.id,
          action: 'automation_note',
          metadata: {
            message: `Revisit reminder created for held deal "${deal.name}".`,
            workflow: WORKFLOW_ID,
            kind: 'hold_revisit',
            taskId: task.id,
          },
        });
        return true;
      });

      if (madeTask) {
        created += 1;
        if (deal.ownerId) {
          await recordNotificationSafe({
            tenantId,
            recipientUserId: deal.ownerId,
            actorUserId: null,
            type: 'task_assigned',
            title: `Revisit held deal: ${deal.name}`,
            subtitle: deal.holdRevisitOn ? `Revisit due ${deal.holdRevisitOn}` : null,
            entityType: 'deal',
            entityId: deal.id,
            metadata: { workflow: WORKFLOW_ID },
          });
        }
      }
    }

    await recordWorkflowSuccess({
      runId: trackingId,
      metadata: { due: due.length, created },
    });
    return created;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureError(err, {
      category: 'workflow.hold-revisit-daily',
      severity: 'high',
      retryable: true,
      fields: { tenantId },
    });
    incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
    await recordWorkflowFailure({ runId: trackingId, error: message });
    throw err;
  }
}
