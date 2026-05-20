import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import { emailMessages } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { attachOrCreateThread } from './writer';

/**
 * One-time backfill: walk existing `email_messages` rows where
 * `thread_id IS NULL` and stitch them into `communication_threads`.
 *
 * Properties:
 *   - **Idempotent** — re-running skips messages that already have
 *     a thread_id.
 *   - **Resumable** — processes in chunks, commits each chunk's
 *     writes inside its own transaction. A crash on chunk 7 doesn't
 *     redo chunks 1-6.
 *   - **Chunked** — default 200 messages per chunk to bound write
 *     volume per transaction.
 *   - **Tenant-scoped** — the caller passes one tenantId; the loop
 *     never crosses tenants.
 *
 * Threading reuses the same `attachOrCreateThread` writer the live
 * send path will use (CP#16C-C). That gives us a single source of
 * truth for "what's a thread" — backfill cannot drift from realtime.
 *
 * Returns counts so the caller can render progress + decide whether
 * to run again.
 */
export type BackfillStats = {
  totalProcessed: number;
  threadsCreated: number;
  threadsReused: number;
  errors: number;
};

export async function backfillThreadsForTenant(
  tenantId: string,
  options: { chunkSize?: number; maxChunks?: number } = {},
): Promise<BackfillStats> {
  const chunkSize = options.chunkSize ?? 200;
  const maxChunks = options.maxChunks ?? Infinity;

  const stats: BackfillStats = {
    totalProcessed: 0,
    threadsCreated: 0,
    threadsReused: 0,
    errors: 0,
  };

  for (let chunk = 0; chunk < maxChunks; chunk++) {
    // Pull the next unthreaded slice. ORDER BY created_at keeps the
    // walk deterministic — same input → same threading outcome
    // regardless of how the chunks split.
    const messages = await tenantTransaction(async (tx) =>
      tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            isNull(emailMessages.threadId),
          ),
        )
        .orderBy(sql`${emailMessages.createdAt} ASC`)
        .limit(chunkSize),
    );
    if (messages.length === 0) break;

    // Process each message inside a small per-message transaction.
    // Per-message rather than per-chunk so one bad row (e.g. a
    // missing entity ref) doesn't poison the entire batch.
    for (const m of messages) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.tenant_id', ${tenantId}::text, true)`,
          );
          await tx.execute(
            sql`SELECT set_config('app.user_id', ${m.actorUserId ?? ''}::text, true)`,
          );

          const allParticipants = [
            { address: m.sender, role: 'from' as const },
            ...m.toRecipients.map((a: string) => ({ address: a, role: 'to' as const })),
            ...m.ccRecipients.map((a: string) => ({ address: a, role: 'cc' as const })),
            ...m.bccRecipients.map((a: string) => ({ address: a, role: 'bcc' as const })),
          ];

          const result = await attachOrCreateThread(tx, {
            tenantId,
            subjectRaw: m.subject,
            entityType: m.entityType ?? null,
            entityId: m.entityId ?? null,
            participants: allParticipants,
            messagePreview: (m.textBody ?? '').slice(0, 140),
            hasAttachments: false, // CP#16C-A doesn't track attachments yet
            timestamp: m.createdAt,
            failedDelivery: m.status === 'failed',
          });

          await tx
            .update(emailMessages)
            .set({ threadId: result.threadId })
            .where(eq(emailMessages.id, m.id));

          if (result.created) {
            stats.threadsCreated++;
          } else {
            stats.threadsReused++;
          }
        });
        stats.totalProcessed++;
      } catch (err) {
        stats.errors++;
        console.error('[backfill] message failed', m.id, err);
      }
    }
  }

  return stats;
}
