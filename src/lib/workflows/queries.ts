import 'server-only';

import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { type WorkflowRun, workflowRuns } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';

export type ListWorkflowRunsOptions = {
  cursor?: Cursor | null;
  size?: PageSize;
};

/**
 * Workflow runs paginated by `(started_at desc, id)`. The
 * `(tenant_id, started_at)` index from migration 0006 covers the
 * predicate; tuple comparison on `(started_at, id)` keeps the cursor
 * deterministic across rows that started in the same millisecond.
 */
export async function listWorkflowRuns(
  tenantId: string,
  options: ListWorkflowRunsOptions = {},
): Promise<Page<WorkflowRun>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  const conditions: SQL[] = [eq(workflowRuns.tenantId, tenantId)];
  if (options.cursor) {
    conditions.push(
      sql`(${workflowRuns.startedAt}, ${workflowRuns.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }
  return await timeQuery('workflows.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select()
        .from(workflowRuns)
        .where(and(...conditions))
        .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
        .limit(size + 1),
    );
    return buildPage(rows, size, (r) => ({
      ts: r.startedAt.toISOString(),
      id: r.id,
    }));
  });
}
