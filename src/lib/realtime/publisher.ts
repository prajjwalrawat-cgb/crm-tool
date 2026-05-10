import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import {
  type RealtimeEnvelope,
  type RealtimeEvent,
  tenantChannel,
} from './events';

/**
 * Drizzle's transaction handle type — same shape we use elsewhere. We
 * accept either the root `db` or a tx so callers can compose the publish
 * step into the same transaction as the mutation it describes (atomic:
 * the event ships iff the row commits).
 */
type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DrizzleTx;

/**
 * Postgres `pg_notify` payloads are capped at 8000 bytes. Most of our
 * events are well under that, but a serialized DealRow with long names
 * could push past the limit. We hard-fail on oversize so a silent
 * truncation never corrupts a downstream client.
 */
const MAX_PAYLOAD_BYTES = 7800;

/**
 * Publish a realtime event to the tenant channel inside a transaction.
 * Wrap in the SAME transaction as the row mutation to get
 * mutation-and-event atomicity:
 *
 *   await tenantTransaction(async (tx) => {
 *     const [row] = await tx.insert(...).returning();
 *     await recordActivity(tx, ...);
 *     await publishRealtimeEvent(tx, { type: 'company.created', ...});
 *     return row;
 *   });
 *
 * If the transaction rolls back, the NOTIFY is rolled back too — Postgres
 * holds notifies until commit and discards them on rollback.
 */
export async function publishRealtimeEvent(
  executor: Executor,
  event: RealtimeEvent,
): Promise<void> {
  const envelope: RealtimeEnvelope = {
    id: crypto.randomUUID(),
    emittedAt: new Date().toISOString(),
    event,
  };

  const payload = JSON.stringify(envelope);

  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    // Loud failure beats a silently dropped event. If this trips, we'll
    // need to either trim the event payload or store the body in a side
    // table and notify with the row id only.
    throw new Error(
      `Realtime event payload exceeds ${MAX_PAYLOAD_BYTES} bytes; trim metadata or move to a row-pointer pattern.`,
    );
  }

  const channel = tenantChannel(event.tenantId);

  // pg_notify takes the channel as its first arg and the payload as the
  // second. Both are TEXT, so we parameterize them.
  await executor.execute(sql`select pg_notify(${channel}, ${payload})`);
}
