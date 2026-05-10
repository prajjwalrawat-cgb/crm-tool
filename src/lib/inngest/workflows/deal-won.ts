import { db } from '@/db';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext } from '@/lib/db-context';
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
