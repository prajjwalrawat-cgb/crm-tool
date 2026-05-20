import 'server-only';

import { and, desc, eq, gt, sql, type SQL } from 'drizzle-orm';

import {
  communicationParticipants,
  communicationThreads,
  type CommunicationThread,
  type ParticipantRole,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import {
  buildPage,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';

import type { InboxCursor, InboxFilter, InboxThreadRow } from './types';

/**
 * List threads for the inbox view, newest-first. The query is a
 * single indexed scan on `communication_threads` using the
 * `(tenant_id, last_message_at DESC, id DESC)` index. Participants
 * are loaded in a separate small query keyed by `IN (...thread ids)`
 * so there's no N+1 risk and no giant left-join.
 *
 * Pagination is cursor-based on `(last_message_at, id)` so newly-
 * arrived threads at the top don't push existing entries into the
 * next page mid-scroll.
 */
export async function listInboxThreads(
  tenantId: string,
  options: {
    cursor?: InboxCursor | null;
    size?: PageSize;
    filter?: InboxFilter;
  } = {},
): Promise<Page<InboxThreadRow>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  const filter = options.filter ?? {};
  const conditions: SQL[] = [eq(communicationThreads.tenantId, tenantId)];

  conditions.push(
    eq(communicationThreads.threadStatus, filter.status ?? 'active'),
  );
  if (filter.unreadOnly) {
    conditions.push(gt(communicationThreads.unreadCount, 0));
  }
  if (filter.failedOnly) {
    conditions.push(gt(communicationThreads.failedCount, 0));
  }
  if (filter.entityType && filter.entityId) {
    conditions.push(eq(communicationThreads.entityType, filter.entityType));
    conditions.push(
      eq(communicationThreads.entityId, filter.entityId),
    );
  }
  if (options.cursor) {
    conditions.push(
      sql`(${communicationThreads.lastMessageAt}, ${communicationThreads.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(communicationThreads)
      .where(and(...conditions))
      .orderBy(
        desc(communicationThreads.lastMessageAt),
        desc(communicationThreads.id),
      )
      .limit(size + 1),
  );

  if (rows.length === 0) {
    return buildPage<CommunicationThread>([], size, () => ({
      ts: '',
      id: '',
    })) as Page<InboxThreadRow>;
  }

  // Pull participants for the visible threads in one batch. Only the
  // first `size` rows are user-facing — the `size + 1` slot is the
  // cursor probe and never rendered.
  const threadIds = rows.slice(0, size).map((r) => r.id);
  const participants =
    threadIds.length === 0
      ? []
      : await tenantTransaction(async (tx) =>
          tx
            .select({
              threadId: communicationParticipants.threadId,
              emailAddress: communicationParticipants.emailAddress,
              participantRole: communicationParticipants.participantRole,
              contactId: communicationParticipants.contactId,
            })
            .from(communicationParticipants)
            .where(
              and(
                eq(communicationParticipants.tenantId, tenantId),
                sql`${communicationParticipants.threadId} = ANY(${sql.raw(`ARRAY[${threadIds.map((id) => `'${id}'::uuid`).join(',')}]`)})`,
              ),
            ),
        );

  const byThread = new Map<string, InboxThreadRow['participants']>();
  for (const p of participants) {
    const arr = byThread.get(p.threadId) ?? [];
    arr.push({
      emailAddress: p.emailAddress,
      participantRole: p.participantRole as ParticipantRole,
      contactId: p.contactId,
    });
    byThread.set(p.threadId, arr);
  }

  // Sort participant arrays: 'from' first, then 'to'/'cc'/'bcc'.
  const roleRank: Record<ParticipantRole, number> = {
    from: 0,
    to: 1,
    cc: 2,
    bcc: 3,
  };
  for (const arr of byThread.values()) {
    arr.sort(
      (a, b) =>
        roleRank[a.participantRole] - roleRank[b.participantRole],
    );
  }

  const enriched: InboxThreadRow[] = rows.map((r) => ({
    ...r,
    participants: byThread.get(r.id) ?? [],
  }));

  return buildPage(enriched, size, (r) => ({
    ts: r.lastMessageAt.toISOString(),
    id: r.id,
  }));
}

/**
 * Single thread by id. Used by the thread detail view and by the
 * realtime "swap on update" handler.
 */
export async function getThreadById(
  tenantId: string,
  threadId: string,
): Promise<InboxThreadRow | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(communicationThreads)
      .where(
        and(
          eq(communicationThreads.tenantId, tenantId),
          eq(communicationThreads.id, threadId),
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) return null;

  const participants = await tenantTransaction(async (tx) =>
    tx
      .select({
        emailAddress: communicationParticipants.emailAddress,
        participantRole: communicationParticipants.participantRole,
        contactId: communicationParticipants.contactId,
      })
      .from(communicationParticipants)
      .where(
        and(
          eq(communicationParticipants.tenantId, tenantId),
          eq(communicationParticipants.threadId, threadId),
        ),
      ),
  );

  return {
    ...row,
    participants: participants.map((p) => ({
      emailAddress: p.emailAddress,
      participantRole: p.participantRole as ParticipantRole,
      contactId: p.contactId,
    })),
  };
}

/**
 * Quick counts used by the sidebar nav badge: total active / unread
 * / failed. One indexed scan each on the partial indexes.
 */
export async function getInboxCounts(tenantId: string): Promise<{
  active: number;
  unread: number;
  failed: number;
}> {
  const result = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE thread_status = 'active')::int                  AS "active",
        count(*) FILTER (WHERE thread_status = 'active' AND unread_count > 0)::int AS "unread",
        count(*) FILTER (WHERE thread_status = 'active' AND failed_count > 0)::int AS "failed"
      FROM communication_threads
      WHERE tenant_id = ${tenantId}::uuid
    `),
  )) as unknown as Array<{ active: number; unread: number; failed: number }>;

  return (
    result[0] ?? { active: 0, unread: 0, failed: 0 }
  );
}
