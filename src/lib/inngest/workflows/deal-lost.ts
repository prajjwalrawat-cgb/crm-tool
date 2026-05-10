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
  recordWorkflowStart,
  recordWorkflowSkipped,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'deal-lost';

/**
 * Triggered on every `crm/deal.stage_changed`. Like `deal-won`, this
 * filters in the body. When a deal lands in the "lost" stage we drop a
 * loss-analysis automation_note onto the timeline so the owner sees a
 * standing prompt to capture the why. No follow-up sleep — losses don't
 * need a 7-day reminder, they need an immediate retro.
 *
 * Other "regression" stage transitions (won → negotiation, etc.) are
 * deliberately ignored here; if we want a "deal regressed" workflow
 * later it'll be its own handler with its own filter.
 */
export async function dealLostHandler(args: {
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
      if (event.data.to !== 'lost') {
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

      // Idempotency belt: if the previous stage was already 'lost' then
      // this is a redundant fire (e.g., a duplicate event) and we skip.
      // The activity feed would otherwise grow loss-analysis notes on
      // every retry.
      if (from === 'lost') {
        await step.run('record-skip', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowSkipped({
              runId: trackingId,
              metadata: { reason: 'already_lost', from, to, source },
            }),
          ),
        );
        incr('workflow.skipped', 1, { workflow: WORKFLOW_ID });
        return { ok: true, skipped: true, reason: 'already_lost' };
      }

      try {
        await step.run('write-loss-analysis-activity', async () =>
          runWithSystemContext(tenantId, async () => {
            await recordActivity(db, {
              tenantId,
              actorUserId: null,
              entityType: 'deal',
              entityId: dealId,
              action: 'automation_note',
              metadata: {
                message: `Deal "${name}" was marked lost (from ${from}). Capture the loss reason — pricing, timing, competitor, fit — while it's fresh.`,
                workflow: WORKFLOW_ID,
                kind: 'loss-analysis',
                from,
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
          category: 'workflow.deal-lost',
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

export const dealLost = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Deal lost — capture loss analysis prompt',
    retries: 2,
    triggers: [dealStageChangedEvent],
  },
  async ({ event, step, runId }) =>
    dealLostHandler({ event, step: step as unknown as LocalStepAPI, runId }),
);
