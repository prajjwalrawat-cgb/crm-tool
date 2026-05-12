import 'server-only';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { notifications, type Notification } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Read-side helpers for the notification dropdown. RLS already
 * filters to `recipient_user_id = current_setting('app.user_id')`,
 * but we keep the explicit `eq(recipientUserId, ...)` predicate so
 * the planner uses the (tenant_id, recipient_user_id, created_at)
 * composite index.
 */

export async function listNotificationsForUser(
  tenantId: string,
  userId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<Notification[]> {
  const limit = options.limit ?? 50;
  return await tenantTransaction(async (tx) => {
    const where = and(
      eq(notifications.tenantId, tenantId),
      eq(notifications.recipientUserId, userId),
      options.unreadOnly ? isNull(notifications.readAt) : undefined,
    );
    return await tx
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  });
}

export async function countUnreadNotifications(
  tenantId: string,
  userId: string,
): Promise<number> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM notifications
      WHERE tenant_id = ${tenantId}::uuid
        AND recipient_user_id = ${userId}
        AND read_at IS NULL
    `),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
