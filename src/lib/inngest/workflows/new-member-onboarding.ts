import { db } from '@/db';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext } from '@/lib/db-context';
import {
  captureError,
  incr,
  observe,
  runWithTrace,
} from '@/lib/observability';

import { inngest, memberInvitedEvent } from '../client';
import type { WorkflowEvents } from '../events';
import type { LocalStepAPI, WorkflowSource } from '../local-step';
import {
  recordWorkflowFailure,
  recordWorkflowStart,
  recordWorkflowSuccess,
} from '../run-tracker';

const WORKFLOW_ID = 'new-member-onboarding';

export async function newMemberOnboardingHandler(args: {
  event: { data: WorkflowEvents['crm/member.invited'] };
  step: LocalStepAPI;
  runId: string;
  source?: WorkflowSource;
}): Promise<{ ok: boolean }> {
  return await runWithTrace(
    { origin: 'workflow', name: WORKFLOW_ID },
    async () => {
      const { event, step, runId } = args;
      const source = args.source ?? 'inngest';
      const startedAt = Date.now();
      incr('workflow.started', 1, { workflow: WORKFLOW_ID, source });

      const { tenantId, email, role, invitationId, inviterUserId } = event.data;

      const trackingId = await step.run('record-start', async () =>
        runWithSystemContext(tenantId, () =>
          recordWorkflowStart({
            tenantId,
            workflowId: WORKFLOW_ID,
            eventName: 'crm/member.invited',
            inngestRunId: runId,
            metadata: { email, role, invitationId, inviterUserId, source },
          }),
        ),
      );

      try {
        await step.run('write-onboarding-activity', async () =>
          runWithSystemContext(tenantId, async () => {
            await recordActivity(db, {
              tenantId,
              actorUserId: null,
              entityType: 'invitation',
              entityId: invitationId,
              action: 'automation_note',
              metadata: {
                message: `Onboarding queued for ${email} (${role}). Once they accept, walk them through the pipeline and grant deal ownership where relevant.`,
                workflow: WORKFLOW_ID,
                kind: 'onboarding',
                email,
                role,
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
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        captureError(err, {
          category: 'workflow.new-member-onboarding',
          severity: 'medium',
          retryable: true,
          fields: { tenantId, email, runId },
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

export const newMemberOnboarding = inngest.createFunction(
  {
    id: WORKFLOW_ID,
    name: 'New member — onboarding note',
    retries: 2,
    triggers: [memberInvitedEvent],
  },
  async ({ event, step, runId }) =>
    newMemberOnboardingHandler({ event, step: step as unknown as LocalStepAPI, runId }),
);
