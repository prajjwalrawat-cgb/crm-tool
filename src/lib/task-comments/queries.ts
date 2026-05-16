import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { taskComments, type TaskComment } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Load every comment on a task, oldest first. Capped to a generous
 * per-task limit — task threads stay short in practice.
 */
export async function listCommentsForTask(
  tenantId: string,
  taskId: string,
  options: { limit?: number } = {},
): Promise<TaskComment[]> {
  const limit = options.limit ?? 200;
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(taskComments)
      .where(
        and(
          eq(taskComments.tenantId, tenantId),
          eq(taskComments.taskId, taskId),
        ),
      )
      .orderBy(asc(taskComments.createdAt))
      .limit(limit),
  );
}
