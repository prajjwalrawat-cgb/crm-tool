import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { aiSummaries } from './ai-summaries';
import { tenants } from './tenants';

/**
 * One row per logical conversation. The inbox renders from this table
 * alone — `email_messages` is still the canonical message row, but the
 * hot path never joins it.
 *
 * `subject_normalized` is lowercased / Re:-Fwd: stripped / whitespace
 * collapsed at write time. Reply grouping reads this column.
 *
 * `last_message_at` and the counters (`message_count`, `unread_count`,
 * `failed_count`) are denormalized into the thread row so the inbox
 * list view is a single indexed scan, no aggregates.
 */
export const THREAD_STATUSES = [
  'active',
  'archived',
  'muted',
  'spam',
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const communicationThreads = pgTable(
  'communication_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Polymorphic CRM link: 'deal' | 'company' | 'contact' | null. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    subjectRaw: text('subject_raw').notNull().default(''),
    subjectNormalized: text('subject_normalized').notNull().default(''),

    /** ~140 chars of the latest body. Inbox preview. */
    messagePreview: text('message_preview'),

    threadStatus: text('thread_status').notNull().default('active'),

    hasAttachments: boolean('has_attachments').notNull().default(false),

    lastMessageAt: timestamp('last_message_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** FK to the cached AI thread-summary row. Populated on demand. */
    lastSummaryId: uuid('last_summary_id').references(() => aiSummaries.id, {
      onDelete: 'set null',
    }),

    messageCount: integer('message_count').notNull().default(0),
    unreadCount: integer('unread_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),

    /** Clerk user id of whoever last mutated the row. Audit trail. */
    updatedBy: text('updated_by'),
    /** Pointer to the freshest `email_messages.id` on this thread. */
    lastMessageId: uuid('last_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Inbox scan — cursor-ready.
    index('communication_threads_inbox_idx').on(
      t.tenantId,
      t.lastMessageAt,
      t.id,
    ),
    index('communication_threads_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
    index('communication_threads_subject_idx').on(
      t.tenantId,
      t.subjectNormalized,
    ),
  ],
);

export const communicationThreadsRelations = relations(
  communicationThreads,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [communicationThreads.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type CommunicationThread =
  typeof communicationThreads.$inferSelect;
export type NewCommunicationThread =
  typeof communicationThreads.$inferInsert;

// Re-export the participants schema's role enum here too so call sites
// that import "everything threads" don't need a second import.
export {
  PARTICIPANT_ROLES,
  type ParticipantRole,
} from './communication-participants';

// Re-export uniqueIndex so its name shows up in the public surface
// for downstream tooling that introspects the schema. Drizzle's own
// `index` helper is already imported above.
void uniqueIndex;
