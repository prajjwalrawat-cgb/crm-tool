import { eq, and, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { deals, tasks } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { recordNotificationSafe } from '@/lib/notifications/recorder';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { dealStageChangedEvent, inngest } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI, WorkflowSource } from '../local-step';
import {
  recordWorkflowFailure,
  recordWorkflowSkipped,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'deal-won';

/**
 * Pure handler body — see regenerate-embedding.ts for why this is split
 * out from the Inngest wrapper. `step.sleep` becomes a no-op when this
 * runs through the local dispatcher; the follow-up step fires
 * immediately. Production via Inngest preserves the 7-day delay.
 */
export async function dealWonHandler(args: {
  event: { data: WorkflowEvents['crm/deal.stage_changed'] };
  step: LocalStepAPI;
  runId: string;
  source?: WorkflowSource;
}): Promise<{ ok: boolean; trackingId?: string; skipped?: boolean; reason?: string }> {
  return await runWithTrace(
    { origin: 'workflow', name: WORKFLOW_ID },
    async () => {
      const { event, step, runId } = args;
      const source = args.source ?? 'inngest';
      if (event.data.to !== 'won') {
        incr('workflow.deal-won.skipped_stage');
        return { ok: true, skipped: true, reason: `stage=${event.data.to}` };
      }

      const startedAt = Date.now();
      incr('workflow.started', 1, { workflow: WORKFLOW_ID, source });

      const { tenantId, dealId, name, from, to } = event.data;

      const trackingId = await step.run('record-start', async () =>
        runWithSystemContext(tenantId, () =>
          recordWorkflowStart({
            tenantId,
            workflowId: WORKFLOW_ID,
            eventName: 'crm/deal.stage_changed',
            inngestRunId: runId,
            metadata: { dealId, dealName: name, from, to, source },
          }),
        ),
      );

      // Idempotency belt — same shape as deal-lost. If the deal was
      // already at "won" before this transition (e.g., a duplicate
      // event, a retry, or a no-op stage save) skip the celebration +
      // 7-day follow-up so the timeline doesn't accumulate duplicate
      // automation notes. Mark as skipped so the run stays visible.
      if (from === 'won') {
        await step.run('record-skip', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowSkipped({
              runId: trackingId,
              metadata: { reason: 'already_won', from, to, source },
            }),
          ),
        );
        incr('workflow.skipped', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { ok: true, skipped: true, reason: 'already_won' };
      }

      try {
        await step.run('write-celebration-activity', async () =>
          runWithSystemContext(tenantId, async () => {
            await recordActivity(db, {
              tenantId,
              actorUserId: null,
              entityType: 'deal',
              entityId: dealId,
              action: 'automation_note',
              metadata: {
                message: `Deal "${name}" was marked won. Schedule the kickoff and capture the win.`,
                workflow: WORKFLOW_ID,
                kind: 'celebration',
              },
            });
          }),
        );

        // Auto-create an onboarding kickoff task assigned to the deal's
        // owner. This is the first concrete "workflow → actionable
        // work" bridge. If the deal has no owner the task is left
        // unassigned and shows up under the "Unassigned" task filter.
        await step.run('create-onboarding-task', async () =>
          runWithSystemContext(tenantId, async () => {
            // Critical path: task insert + activity log atomic. Notification
            // fan-out runs post-commit (safe) so a notification crash never
            // rolls back the task creation.
            const result = await tenantTransaction(async (tx) => {
              const [deal] = await tx
                .select({ ownerId: deals.ownerId })
                .from(deals)
                .where(
                  and(
                    eq(deals.id, dealId),
                    eq(deals.tenantId, tenantId),
                    isNull(deals.deletedAt),
                  ),
                )
                .limit(1);
              const ownerId = deal?.ownerId ?? null;
              const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
                .toISOString()
                .slice(0, 10);
              const [task] = await tx
                .insert(tasks)
                .values({
                  tenantId,
                  title: `Onboarding kickoff for ${name}`,
                  description:
                    'Auto-created by the deal-won workflow. Schedule a kickoff call, send welcome email, and confirm implementation owner.',
                  status: 'todo',
                  priority: 'high',
                  dueDate,
                  assignedUserId: ownerId,
                  createdBy: 'system',
                  entityType: 'deal',
                  entityId: dealId,
                })
                .returning();
              if (!task) return null;
              await recordActivity(tx, {
                tenantId,
                actorUserId: null,
                entityType: 'task',
                entityId: task.id,
                action: 'created',
                metadata: {
                  taskTitle: task.title,
                  workflow: WORKFLOW_ID,
                  linkedEntityType: 'deal',
                  linkedEntityId: dealId,
                  automation: true,
                },
              });
              return { task, ownerId, dueDate };
            });

            if (result?.ownerId) {
              await recordNotificationSafe({
                tenantId,
                recipientUserId: result.ownerId,
                actorUserId: null,
                type: 'task_assigned',
                title: `Onboarding task created: ${name}`,
                subtitle: `Due ${result.dueDate}`,
                entityType: 'task',
                entityId: result.task.id,
                metadata: { workflow: WORKFLOW_ID, automation: true },
              });
            }
          }),
        );

        await step.sleep('wait-for-followup', '7d');

        await step.run('write-followup-activity', async () =>
          runWithSystemContext(tenantId, async () => {
            await recordActivity(db, {
              tenantId,
              actorUserId: null,
              entityType: 'deal',
              entityId: dealId,
              action: 'automation_note',
              metadata: {
                message: `Follow-up reminder for "${name}" — check in with the customer one week after closing.`,
                workflow: WORKFLOW_ID,
                kind: 'followup',
              },
            });
          }),
        );

        await step.run('record-success', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowSuccess({ runId: trackingId }),
          ),
        );

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { ok: true, trackingId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        captureError(err, {
          category: 'workflow.deal-won',
          severity: 'high',
          retryable: true,
          fields: { tenantId, dealId, runId },
        });
        incr('workflow.failure', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        await step.run('record-failure', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowFailure({ runId: trackingId, error: message }),
          ),
        );
        throw err;
      }
    },
  );
}

export const dealWon = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Deal won — celebrate and schedule follow-up',
    retries: 3,
    triggers: [dealStageChangedEvent],
  },
  async ({ event, step, runId }) =>
    dealWonHandler({ event, step: step as unknown as LocalStepAPI, runId }),
);
