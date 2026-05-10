import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { type WorkflowRun, workflowRuns } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export async function listWorkflowRuns(
  tenantId: string,
  options: { limit?: number } = {},
): Promise<WorkflowRun[]> {
  const limit = options.limit ?? 100;
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.tenantId, tenantId))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit),
  );
}
