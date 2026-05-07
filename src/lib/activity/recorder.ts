import 'server-only';

import { db } from '@/db';
import {
  type ActivityAction,
  type ActivityEntityType,
  activityLogs,
} from '@/db/schema';

/**
 * Drizzle's `db.transaction` callback receives a typed transaction handle.
 * We accept either the root `db` or that handle so callers can compose the
 * activity write into the same transaction as their mutation, getting
 * atomic "mutation + log" semantics for free.
 */
export type ActivityExecutor = Pick<typeof db, 'insert'>;

export type RecordActivityInput = {
  tenantId: string;
  /** Clerk user id of the actor. Pass `null` only for system-generated events. */
  actorUserId: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  action: ActivityAction;
  metadata?: Record<string, unknown>;
};

/**
 * Insert a single activity_logs row. Always called inside the same
 * transaction as the mutation that produced it; if you can't (e.g. the
 * mutation is a Clerk SDK call that we can't tx-wrap), call it
 * immediately after on the bare `db` and accept the small at-most-once
 * gap.
 */
export async function recordActivity(
  executor: ActivityExecutor,
  input: RecordActivityInput,
): Promise<void> {
  await executor.insert(activityLogs).values({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    metadata: input.metadata ?? {},
  });
}
