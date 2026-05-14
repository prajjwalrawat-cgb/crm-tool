import 'server-only';

import { db } from '@/db';
import { notifications, type NotificationType } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { captureError, logger } from '@/lib/observability';
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
 * Best-effort notification fan-out. Runs OUTSIDE of any caller's
 * transaction (opens its own) and **never throws** — failures are
 * logged via the observability layer and the outer business operation
 * is allowed to complete.
 *
 * Use this from server actions where the notification is ancillary to
 * the core operation (e.g. "task was completed" → notify the creator).
 * A notification crash must never roll back the task update.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, message }` so
 * callers can surface a soft warning if they want to. Most callers
 * ignore the result.
 */
export async function recordNotificationSafe(
  input: RecordNotificationInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await tenantTransaction(async (tx) => {
      await writeAndPublish(tx, input);
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('notification.publish_failed', {
      tenantId: input.tenantId,
      recipientUserId: input.recipientUserId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      reason: message,
    });
    captureError(err instanceof Error ? err : new Error(message), {
      category: 'notification.publish_failed',
      severity: 'low',
      retryable: true,
      fields: {
        recipientUserId: input.recipientUserId,
        type: input.type,
        entityType: input.entityType ?? null,
      },
    });
    return { ok: false, message };
  }
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
