import 'server-only';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { comments, type Comment } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';

export type CommentEntityType = 'deal' | 'company' | 'contact';

/**
 * Load all live comments for an entity, oldest first. The detail
 * page does not paginate the thread (typical entity will accumulate
 * tens of comments, not thousands); we cap the read at 200 as a
 * defense and surface a "load older" cue later if it ever matters.
 */
export async function listCommentsForEntity(
  tenantId: string,
  entityType: CommentEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<Comment[]> {
  const limit = options.limit ?? 200;
  return await timeQuery('comments.forEntity', async () =>
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.tenantId, tenantId),
            eq(comments.entityType, entityType),
            eq(comments.entityId, entityId),
            isNull(comments.deletedAt),
          ),
        )
        .orderBy(asc(comments.createdAt))
        .limit(limit),
    ),
  );
}
