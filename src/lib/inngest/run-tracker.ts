import 'server-only';

import { eq } from 'drizzle-orm';

import { workflowRuns, type WorkflowStatus } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Row-id helpers for `workflow_runs`. Workflows call `recordWorkflowStart`
 * at their first step, then `recordWorkflowSuccess` / `recordWorkflowFailure`
 * at their end. The runs table is the portable, tenant-scoped projection
 * we surface in `/dashboard/workflows`.
 *
 * Each helper requires a tenant context set by the caller (via
 * `runWithSystemContext` from inside an Inngest function). The DB row lives
 * under RLS like any other tenant-scoped table — workflow runs in tenant A
 * are invisible to tenant B even from within Inngest.
 */

export type StartWorkflowInput = {
  tenantId: string;
  workflowId: string;
  eventName?: string;
  inngestRunId?: string;
  metadata?: Record<string, unknown>;
};

export async function recordWorkflowStart(
  input: StartWorkflowInput,
): Promise<string> {
  const id = await tenantTransaction(async (tx) => {
    const [row] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        eventName: input.eventName ?? null,
        inngestRunId: input.inngestRunId ?? null,
        status: 'running',
        metadata: input.metadata ?? {},
      })
      .returning({ id: workflowRuns.id });
    return row?.id ?? null;
  });
  if (!id) {
    throw new Error('Failed to record workflow start');
  }
  return id;
}

type FinishInput = {
  runId: string;
  metadata?: Record<string, unknown>;
};

async function finish(
  status: WorkflowStatus,
  input: FinishInput,
  error?: string,
): Promise<void> {
  await tenantTransaction(async (tx) => {
    await tx
      .update(workflowRuns)
      .set({
        status,
        completedAt: new Date(),
        error: error ?? null,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      .where(eq(workflowRuns.id, input.runId));
  });
}

export async function recordWorkflowSuccess(input: FinishInput): Promise<void> {
  await finish('completed', input);
}

export async function recordWorkflowSkipped(input: FinishInput): Promise<void> {
  await finish('skipped', input);
}

export async function recordWorkflowFailure(
  input: FinishInput & { error: string },
): Promise<void> {
  await finish('failed', input, input.error);
}
