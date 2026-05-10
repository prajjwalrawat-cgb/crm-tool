import { deleteEntityEmbedding, upsertEntityEmbedding } from '@/lib/ai/embed';
import {
  buildCompanyEmbedText,
  buildContactEmbedText,
  buildDealEmbedText,
} from '@/lib/ai/text';
import { runWithSystemContext } from '@/lib/db-context';
import {
  captureError,
  incr,
  logger,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { embedEntityEvent, inngest } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI, WorkflowSource } from '../local-step';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSkipped,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'regenerate-embedding';

/**
 * Pure handler body. Exposed separately from the Inngest-wrapped export
 * so the in-process local dispatcher (`local-dispatcher.ts`) can call
 * the same logic with a stub `step` when the Inngest dev server isn't
 * running. When invoked by Inngest itself, the real `step` object is
 * passed and durability/retries work normally.
 */
export async function regenerateEmbeddingHandler(args: {
  event: { data: WorkflowEvents['crm/ai.embed_entity'] };
  step: LocalStepAPI;
  runId: string;
  source?: WorkflowSource;
}): Promise<{ ok: boolean; outcome: string }> {
  return await runWithTrace(
    { origin: 'workflow', name: WORKFLOW_ID },
    async () => {
      const { event, step, runId } = args;
      const source = args.source ?? 'inngest';
      const { tenantId, entityType, entityId, actorUserId, reason } = event.data;
      const startedAt = Date.now();
      incr('workflow.started', 1, { workflow: WORKFLOW_ID, source });

      const trackingId = await step.run('record-start', async () =>
        runWithSystemContext(tenantId, () =>
          recordWorkflowStart({
            tenantId,
            workflowId: WORKFLOW_ID,
            eventName: 'crm/ai.embed_entity',
            inngestRunId: runId,
            metadata: { entityType, entityId, reason, source },
          }),
        ),
      );

      try {
        const result = await step.run('upsert-embedding', async () =>
          runWithSystemContext(tenantId, async () => {
            const sourceText = await loadSourceText(tenantId, entityType, entityId);
            if (!sourceText) {
              await deleteEntityEmbedding({ tenantId, entityType, entityId });
              return { status: 'deleted' as const };
            }
            const status = await upsertEntityEmbedding({
              tenantId,
              entityType,
              entityId,
              content: sourceText,
              actorUserId,
            });
            return { status };
          }),
        );

        if (result.status === 'cached') {
          await step.run('record-skip', async () =>
            runWithSystemContext(tenantId, () =>
              recordWorkflowSkipped({
                runId: trackingId,
                metadata: {
                  entityType,
                  entityId,
                  reason,
                  outcome: 'cached',
                  source,
                },
              }),
            ),
          );
          incr('workflow.skipped', 1, { workflow: WORKFLOW_ID });
          observe('workflow.duration_ms', Date.now() - startedAt, {
            workflow: WORKFLOW_ID,
          });
          return { ok: true, outcome: 'cached' };
        }

        await step.run('record-success', async () =>
          runWithSystemContext(tenantId, () =>
            recordWorkflowSuccess({
              runId: trackingId,
              metadata: {
                entityType,
                entityId,
                reason,
                outcome: result.status,
                source,
              },
            }),
          ),
        );

        incr('workflow.success', 1, { workflow: WORKFLOW_ID });
        observe('workflow.duration_ms', Date.now() - startedAt, {
          workflow: WORKFLOW_ID,
        });
        logger.info('workflow.regenerate-embedding ok', {
          tenantId,
          entityType,
          entityId,
          outcome: result.status,
        });
        return { ok: true, outcome: result.status };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        captureError(err, {
          category: 'workflow.regenerate-embedding',
          severity: 'high',
          retryable: true,
          fields: { tenantId, entityType, entityId, runId },
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

/**
 * Triggered by `crm/ai.embed_entity` from each entity mutation. The
 * workflow rebuilds the canonical source text for the entity, then
 * upserts an embedding row — `upsertEntityEmbedding` short-circuits on
 * unchanged content (SHA-256 match) so re-firing this workflow on
 * trivial updates costs zero OpenAI tokens.
 */
export const regenerateEmbedding = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'Regenerate entity embedding',
    retries: 3,
    throttle: { limit: 50, period: '1m', key: 'event.data.tenantId' },
    triggers: [embedEntityEvent],
  },
  async ({ event, step, runId }) =>
    regenerateEmbeddingHandler({ event, step: step as LocalStepAPI, runId }),
);

async function loadSourceText(
  tenantId: string,
  entityType: 'deal' | 'company' | 'contact',
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case 'deal':
      return buildDealEmbedText(tenantId, entityId);
    case 'company':
      return buildCompanyEmbedText(tenantId, entityId);
    case 'contact':
      return buildContactEmbedText(tenantId, entityId);
  }
}
