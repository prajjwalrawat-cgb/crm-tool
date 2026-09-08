import 'server-only';

import {
  and,
  type Column,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
} from 'drizzle-orm';

import {
  type ActivityLog,
  type Comment,
  type EmailMessage,
  type Note,
  activityLogs,
  comments as commentsTable,
  contacts as contactsTable,
  deals as dealsTable,
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

/**
 * Which record under the account an item actually happened on. Set only
 * by `getAccountTimeline` — a per-entity timeline is already scoped to
 * one record, so labelling every row with it would be noise. On an
 * account feed it is the difference between "Stage changed to Proposal"
 * and knowing WHICH of the account's six deals moved.
 */
export type TimelineSource = {
  type: 'deal' | 'contact';
  id: string;
  name: string;
};

export type TimelineItem =
  | { kind: 'activity'; id: string; createdAt: Date; row: ActivityLog; source?: TimelineSource }
  | { kind: 'note'; id: string; createdAt: Date; row: Note; source?: TimelineSource }
  | { kind: 'comment'; id: string; createdAt: Date; row: Comment; source?: TimelineSource }
  | { kind: 'email'; id: string; createdAt: Date; row: EmailMessage; source?: TimelineSource };

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

/**
 * How many of the account's deals / contacts feed the account timeline.
 * Both sets are ordered by `updated_at desc`, so an account with more
 * children than this contributes its most recently touched ones — the
 * ones whose activity a reviewer is actually looking for. Bounding the
 * fan-in keeps the `IN (...)` lists (and the BitmapOr under them)
 * predictable on the pathological "one account owns the whole tenant"
 * shape that every CRM eventually grows.
 */
const ACCOUNT_CHILD_FANIN = 500;

/**
 * Account-scoped timeline: everything that happened on the company
 * itself PLUS everything on every deal and contact tied to it.
 *
 * Same four feeds and the same `TimelineItem` shape as
 * `getEntityTimeline`, so `<EntityTimeline>` renders it unchanged —
 * the only addition is `source`, which names the child record an item
 * came from.
 *
 * Shape of the work: two cheap indexed lookups resolve the child ids
 * (`deals_tenant_company_idx`, `contacts_tenant_company_idx`), then the
 * four feed queries run in parallel with an OR of three
 * `(entity_type, entity_id IN ...)` branches. Keeping `entity_type` in
 * every branch is deliberate — it is the leading column of the
 * per-record index on each of these tables, so the planner gets three
 * index scans it can BitmapOr rather than one filter over the tenant
 * slice.
 *
 * `activity_logs.entity_id` is `text` while the other three are `uuid`;
 * comparing it against our uuid strings as text is exact (the writer
 * stores the same canonical value) and, unlike a cast, cannot trip over
 * the `user_…` / `orginv_…` rows that share the column.
 */
export async function getAccountTimeline(
  tenantId: string,
  companyId: string,
  options: { limit?: number } = {},
): Promise<TimelineItem[]> {
  const limit = options.limit ?? 200;

  return await timeQuery('timeline.account', async () =>
    tenantTransaction(async (tx) => {
      const [dealRows, contactRows] = await Promise.all([
        tx
          .select({ id: dealsTable.id, name: dealsTable.name })
          .from(dealsTable)
          .where(
            and(
              eq(dealsTable.tenantId, tenantId),
              eq(dealsTable.companyId, companyId),
              isNull(dealsTable.deletedAt),
            ),
          )
          .orderBy(desc(dealsTable.updatedAt))
          .limit(ACCOUNT_CHILD_FANIN),

        tx
          .select({
            id: contactsTable.id,
            firstName: contactsTable.firstName,
            lastName: contactsTable.lastName,
          })
          .from(contactsTable)
          .where(
            and(
              eq(contactsTable.tenantId, tenantId),
              eq(contactsTable.companyId, companyId),
              isNull(contactsTable.deletedAt),
              isNull(contactsTable.mergedIntoId),
            ),
          )
          .orderBy(desc(contactsTable.updatedAt))
          .limit(ACCOUNT_CHILD_FANIN),
      ]);

      const sourceById = new Map<string, TimelineSource>();
      for (const d of dealRows) {
        sourceById.set(d.id, { type: 'deal', id: d.id, name: d.name });
      }
      for (const c of contactRows) {
        const name =
          [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact';
        sourceById.set(c.id, { type: 'contact', id: c.id, name });
      }

      const dealIds = dealRows.map((d) => d.id);
      const contactIds = contactRows.map((c) => c.id);

      /**
       * `entity_type` / `entity_id` carry the same meaning on all four
       * tables but are four different column objects, so the scope
       * predicate is built per table. Generic over the two columns so
       * each call site keeps its own value typing rather than widening
       * to `unknown`.
       */
      function scope<TType extends Column, TId extends Column>(
        typeCol: TType,
        idCol: TId,
      ): SQL {
        const branches: SQL[] = [
          and(eq(typeCol, 'company'), eq(idCol, companyId))!,
        ];
        if (dealIds.length > 0) {
          branches.push(and(eq(typeCol, 'deal'), inArray(idCol, dealIds))!);
        }
        if (contactIds.length > 0) {
          branches.push(
            and(eq(typeCol, 'contact'), inArray(idCol, contactIds))!,
          );
        }
        return branches.length === 1 ? branches[0]! : or(...branches)!;
      }

      const [activity, notes, comments, emails] = await Promise.all([
        tx
          .select()
          .from(activityLogs)
          .where(
            and(
              eq(activityLogs.tenantId, tenantId),
              scope(activityLogs.entityType, activityLogs.entityId),
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
              isNull(notesTable.deletedAt),
              scope(notesTable.entityType, notesTable.entityId),
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
              isNull(commentsTable.deletedAt),
              scope(commentsTable.entityType, commentsTable.entityId),
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
              scope(
                emailMessagesTable.entityType,
                emailMessagesTable.entityId,
              ),
            ),
          )
          .orderBy(desc(emailMessagesTable.createdAt))
          .limit(limit),
      ]);

      const items: TimelineItem[] = [];
      for (const a of activity) {
        // Same de-dup rule as the per-entity feed: skip the activity row
        // when the thing it announces is already in the list on its own.
        const meta = (a.metadata ?? {}) as Record<string, unknown>;
        if (meta.commentId || meta.noteId || meta.emailId) continue;
        items.push({
          kind: 'activity',
          id: `a-${a.id}`,
          createdAt: a.createdAt,
          row: a,
          source: sourceById.get(a.entityId),
        });
      }
      for (const n of notes) {
        items.push({
          kind: 'note',
          id: `n-${n.id}`,
          createdAt: n.createdAt,
          row: n,
          source: sourceById.get(n.entityId),
        });
      }
      for (const c of comments) {
        items.push({
          kind: 'comment',
          id: `c-${c.id}`,
          createdAt: c.createdAt,
          row: c,
          source: sourceById.get(c.entityId),
        });
      }
      for (const e of emails) {
        items.push({
          kind: 'email',
          id: `e-${e.id}`,
          createdAt: e.createdAt,
          row: e,
          source: e.entityId ? sourceById.get(e.entityId) : undefined,
        });
      }
      items.sort((x, y) => +y.createdAt - +x.createdAt);
      return items.slice(0, limit);
    }),
  );
}
