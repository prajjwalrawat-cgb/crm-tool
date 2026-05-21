import 'server-only';

import { and, asc, desc, eq } from 'drizzle-orm';

import {
  communicationEvents,
  emailMessages,
  type CommunicationEvent,
  type EmailMessage,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Chronological message list for a thread. Ordered oldest-first so
 * the timeline reads top-down. The runtime cost is one indexed scan
 * on `email_messages(tenant_id, thread_id)` plus an indexed scan on
 * `communication_events(tenant_id, thread_id, created_at DESC)`.
 *
 * Returns BOTH the messages AND the most-recent event per message —
 * the latter drives the delivery pill on each row.
 */
export type ThreadMessageRow = EmailMessage & {
  latestEventKind:
    | CommunicationEvent['eventKind']
    | null;
};

export async function listMessagesForThread(
  tenantId: string,
  threadId: string,
  options: { limit?: number } = {},
): Promise<ThreadMessageRow[]> {
  const limit = options.limit ?? 200;

  const [messages, events] = await Promise.all([
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, tenantId),
            eq(emailMessages.threadId, threadId),
          ),
        )
        .orderBy(asc(emailMessages.createdAt))
        .limit(limit),
    ),
    tenantTransaction(async (tx) =>
      tx
        .select({
          messageId: communicationEvents.messageId,
          eventKind: communicationEvents.eventKind,
          createdAt: communicationEvents.createdAt,
        })
        .from(communicationEvents)
        .where(
          and(
            eq(communicationEvents.tenantId, tenantId),
            eq(communicationEvents.threadId, threadId),
          ),
        )
        .orderBy(desc(communicationEvents.createdAt)),
    ),
  ]);

  // Pick the latest event per messageId. The query above already
  // sorts newest-first; we keep the first hit per id.
  const latestByMessage = new Map<string, CommunicationEvent['eventKind']>();
  for (const e of events) {
    if (!e.messageId) continue;
    if (!latestByMessage.has(e.messageId)) {
      latestByMessage.set(
        e.messageId,
        e.eventKind as CommunicationEvent['eventKind'],
      );
    }
  }

  return messages.map((m) => ({
    ...m,
    latestEventKind: latestByMessage.get(m.id) ?? null,
  }));
}

/**
 * Per-thread event timeline (all events, newest-first). Used to render
 * an audit strip below the messages — "delivered 2h ago, opened 30m ago".
 */
export async function listEventsForThread(
  tenantId: string,
  threadId: string,
  options: { limit?: number } = {},
): Promise<CommunicationEvent[]> {
  const limit = options.limit ?? 100;
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(communicationEvents)
      .where(
        and(
          eq(communicationEvents.tenantId, tenantId),
          eq(communicationEvents.threadId, threadId),
        ),
      )
      .orderBy(desc(communicationEvents.createdAt))
      .limit(limit),
  );
}
