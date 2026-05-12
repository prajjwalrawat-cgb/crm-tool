import 'server-only';

import { db } from '@/db';
import { notifications, type NotificationType } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

/**
 * Append a notification row AND publish a realtime
 * `notification.created` event in the same transaction. Mirrors the
 * pattern in activity/recorder.ts so audit + live stream stay in
 * lockstep.
 *
 * Notifications are per-recipient — pass a list to fan out the same
 * event to multiple users (e.g. a deal-won celebration to every owner
 * involved in the deal). Each call writes one row per recipient.
 */
export type RecordNotificationInput = {
  tenantId: string;
  recipientUserId: string;
  actorUserId: string | null;
  type: NotificationType;
  title: string;
  subtitle?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type NotificationExecutor = typeof db | DrizzleTx;

export async function recordNotification(
  executor: NotificationExecutor,
  input: RecordNotificationInput,
): Promise<void> {
  if (executor === db) {
    await tenantTransaction(async (tx) => {
      await writeAndPublish(tx, input);
    });
    return;
  }
  await writeAndPublish(executor as DrizzleTx, input);
}

/**
 * Bulk variant: same notification, many recipients. One INSERT, one
 * realtime publish per recipient (separate events because the client
 * filters by `recipientUserId`).
 */
export async function recordNotifications(
  executor: NotificationExecutor,
  base: Omit<RecordNotificationInput, 'recipientUserId'>,
  recipientUserIds: string[],
): Promise<void> {
  // Dedup recipients and skip self-notifications — never notify the
  // actor about their own action.
  const seen = new Set<string>();
  const filtered = recipientUserIds.filter((id) => {
    if (!id || seen.has(id) || id === base.actorUserId) return false;
    seen.add(id);
    return true;
  });
  if (filtered.length === 0) return;
  for (const recipientUserId of filtered) {
    await recordNotification(executor, { ...base, recipientUserId });
  }
}

async function writeAndPublish(
  tx: DrizzleTx,
  input: RecordNotificationInput,
): Promise<void> {
  const [row] = await tx
    .insert(notifications)
    .values({
      tenantId: input.tenantId,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId,
      type: input.type,
      title: input.title,
      subtitle: input.subtitle ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!row) return;

  await publishRealtimeEvent(tx, {
    type: 'notification.created',
    tenantId: input.tenantId,
    recipientUserId: row.recipientUserId,
    notification: {
      id: row.id,
      tenantId: row.tenantId,
      recipientUserId: row.recipientUserId,
      actorUserId: row.actorUserId,
      type: row.type,
      entityType: row.entityType,
      entityId: row.entityId,
      title: row.title,
      subtitle: row.subtitle,
      metadata: row.metadata as Record<string, unknown>,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  });
}
