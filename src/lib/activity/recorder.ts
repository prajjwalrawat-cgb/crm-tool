import 'server-only';

import { db } from '@/db';
import {
  type ActivityAction,
  type ActivityEntityType,
  activityLogs,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { serializeActivity } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ActivityExecutor = typeof db | DrizzleTx;

export type RecordActivityInput = {
  tenantId: string;
  actorUserId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  metadata?: Record<string, unknown>;
};

/**
 * Append an activity_logs row AND publish a realtime `activity.recorded`
 * event in the same transaction. Either both ship or neither — Postgres
 * holds NOTIFY until COMMIT and discards on ROLLBACK, so the audit trail
 * and the live feed stay in lockstep.
 */
export async function recordActivity(
  executor: ActivityExecutor,
  input: RecordActivityInput,
): Promise<void> {
  if (executor === db) {
    await tenantTransaction(async (tx) => {
      await writeActivityAndPublish(tx, input);
    });
    return;
  }
  // The `=== db` check narrowed structurally but TS can't infer the
  // remaining branch as DrizzleTx because the two types overlap by shape
  // (both expose insert/select/etc.). Cast: at runtime the only other
  // value an action ever passes is a tx handle.
  await writeActivityAndPublish(executor as DrizzleTx, input);
}

async function writeActivityAndPublish(
  tx: DrizzleTx,
  input: RecordActivityInput,
): Promise<void> {
  const [row] = await tx
    .insert(activityLogs)
    .values({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!row) return;

  await publishRealtimeEvent(tx, {
    type: 'activity.recorded',
    tenantId: input.tenantId,
    entry: serializeActivity(row),
  });
}
