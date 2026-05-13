import 'server-only';

import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  type ActivityLog,
  type Comment,
  type EmailMessage,
  type Note,
  activityLogs,
  comments as commentsTable,
  emailMessages as emailMessagesTable,
  notes as notesTable,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { timeQuery } from '@/lib/pagination/timing';

/**
 * Per-entity unified timeline.
 *
 * Three parallel queries (activity_logs, notes, comments), merged in
 * memory and sorted by timestamp desc. We don't UNION ALL in SQL
 * because the three row shapes are genuinely different (different
 * columns, different metadata) and Postgres UNION requires aligned
 * column lists. Three SELECTs that each fit their natural index is
 * cheaper than one mega-query with NULL padding everywhere.
 *
 * Each item is wrapped in a discriminated `TimelineItem` so the
 * renderer can dispatch cleanly. `createdAt` is the merge key.
 */

export type TimelineEntityType = 'deal' | 'company' | 'contact';

export type TimelineItem =
  | { kind: 'activity'; id: string; createdAt: Date; row: ActivityLog }
  | { kind: 'note'; id: string; createdAt: Date; row: Note }
  | { kind: 'comment'; id: string; createdAt: Date; row: Comment }
  | { kind: 'email'; id: string; createdAt: Date; row: EmailMessage };

export async function getEntityTimeline(
  tenantId: string,
  entityType: TimelineEntityType,
  entityId: string,
  options: { limit?: number } = {},
): Promise<TimelineItem[]> {
  const limit = options.limit ?? 200;

  return await timeQuery('timeline.entity', async () =>
    tenantTransaction(async (tx) => {
      const [activity, notes, comments, emails] = await Promise.all([
        tx
          .select()
          .from(activityLogs)
          .where(
            and(
              eq(activityLogs.tenantId, tenantId),
              eq(activityLogs.entityType, entityType),
              eq(activityLogs.entityId, entityId),
            ),
          )
          .orderBy(desc(activityLogs.createdAt))
          .limit(limit),

        tx
          .select()
          .from(notesTable)
          .where(
            and(
              eq(notesTable.tenantId, tenantId),
              eq(notesTable.entityType, entityType),
              eq(notesTable.entityId, entityId),
              isNull(notesTable.deletedAt),
            ),
          )
          .orderBy(desc(notesTable.createdAt))
          .limit(limit),

        tx
          .select()
          .from(commentsTable)
          .where(
            and(
              eq(commentsTable.tenantId, tenantId),
              eq(commentsTable.entityType, entityType),
              eq(commentsTable.entityId, entityId),
              isNull(commentsTable.deletedAt),
            ),
          )
          .orderBy(desc(commentsTable.createdAt))
          .limit(limit),

        tx
          .select()
          .from(emailMessagesTable)
          .where(
            and(
              eq(emailMessagesTable.tenantId, tenantId),
              eq(emailMessagesTable.entityType, entityType),
              eq(emailMessagesTable.entityId, entityId),
            ),
          )
          .orderBy(desc(emailMessagesTable.createdAt))
          .limit(limit),
      ]);

      const items: TimelineItem[] = [];
      for (const a of activity) {
        // Skip activity rows that are already represented by a sibling
        // note/comment/email. Otherwise the timeline shows "X updated
        // deal" right next to the actual content.
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        if (meta.commentId || meta.noteId || meta.emailId) continue;
        items.push({
          kind: 'activity',
          id: `a-${a.id}`,
          createdAt: a.createdAt,
          row: a,
        });
      }
      for (const n of notes) {
        items.push({
          kind: 'note',
          id: `n-${n.id}`,
          createdAt: n.createdAt,
          row: n,
        });
      }
      for (const c of comments) {
        items.push({
          kind: 'comment',
          id: `c-${c.id}`,
          createdAt: c.createdAt,
          row: c,
        });
      }
      for (const e of emails) {
        items.push({
          kind: 'email',
          id: `e-${e.id}`,
          createdAt: e.createdAt,
          row: e,
        });
      }
      items.sort((x, y) => +y.createdAt - +x.createdAt);
      return items.slice(0, limit);
    }),
  );
}
