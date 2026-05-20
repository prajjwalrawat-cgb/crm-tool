import 'server-only';

import {
  communicationEvents,
  type CommunicationEventKind,
} from '@/db/schema';

type DrizzleTx = Parameters<
  Parameters<typeof import('@/db').db.transaction>[0]
>[0];

/**
 * Append a row to `communication_events`. The ledger is the source
 * of truth for analytics; the thread row's `failed_count` /
 * `last_message_at` are denormalized projections.
 *
 * MUST be called from inside the caller's transaction so the event
 * write and the thread counter update are atomic. The function does
 * not publish a realtime event itself — the caller decides which
 * realtime variant to fire (sent vs failed) and when.
 */
export async function recordCommunicationEvent(
  tx: DrizzleTx,
  input: {
    tenantId: string;
    threadId: string | null;
    messageId: string | null;
    eventKind: CommunicationEventKind;
    provider: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(communicationEvents).values({
    tenantId: input.tenantId,
    threadId: input.threadId,
    messageId: input.messageId,
    eventKind: input.eventKind,
    provider: input.provider,
    metadata: input.metadata ?? {},
  });
}
