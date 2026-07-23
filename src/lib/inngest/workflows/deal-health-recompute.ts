import { runWithSystemContext } from '@/lib/db-context';
import { recomputeDealScore } from '@/lib/deals/scoring/service';
import { captureError, incr, observe, runWithTrace } from '@/lib/observability';

import { dealHealthRecomputeEvent, inngest } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI, WorkflowSource } from '../local-step';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'deal-health-recompute';

/**
 * Pure handler — recompute one deal's health score. Split from the Inngest
 * wrapper so the in-process local dispatcher can run it when Inngest is
 * unreachable in dev (see regenerate-embedding.ts for the rationale).
 *
 * `recomputeDealScore` is itself a no-op when scoring is disabled for the
 * tenant or the deal is closed, so this handler never needs to re-check.
 */
export async function dealHealthRecomputeHandler(args: {
  event: { data: WorkflowEvents['crm/deal.health_recompute'] };
  step: LocalStepAPI;
  runId: string;
  source?: WorkflowSource;
}): Promise<{ ok: boolean; scored: boolean; trackingId?: string }> {
  return await runWithTrace(
    { origin: 'workflow', name: WORKFLOW_ID },
    async () => {
      const { event, step, runId } = args;
      const source = args.source ?? 'inngest';
      const { tenantId, dealId, reason } = event.data;
      const startedAt = Date.now();
      incr('workflow.started', 1, { workflow: WORKFLOW_ID, source });

      const trackingId = await step.run('record-start', async () =>
        runWithSystemContext(tenantId, () =>
          recordWorkflowStart({
            tenantId,
            workflowId: WORKFLOW_ID,
            eventName: 'crm/deal.health_recompute',
            inngestRunId: runId,
            metadata: { dealId, reason, source },
          }),
        ),
      );

      try {
        const score = await step.run('recompute', async () =>
          runWithSystemContext(tenantId, () =>
            recomputeDealScore(tenantId, dealId),
          ),
        );

        await step.run('record-success', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowSuccess({
              runId: trackingId,
              metadata: {
                scored: score != null,
                score: score?.score ?? null,
                band: score?.band ?? null,
              },
            }),
          ),
        );

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        return { ok: true, scored: score != null, trackingId };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        captureError(err, {
          category: 'workflow.deal-health-recompute',
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

export const dealHealthRecompute = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Deal health — recompute score',
    retries: 2,
    // Coalesce a burst of edits on the same deal into one recompute.
    debounce: { period: '5m', key: 'event.data.dealId' },
    triggers: [dealHealthRecomputeEvent],
  },
  async ({ event, step, runId }) =>
    dealHealthRecomputeHandler({
      event,
      step: step as unknown as LocalStepAPI,
      runId,
    }),
);
