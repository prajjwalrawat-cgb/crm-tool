import { type AnyPgColumn, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

import { tenants } from './tenants';

/**
 * Threaded entity comments.
 *
 * Two-tier threading: top-level comments and one level of replies.
 * `parent_comment_id` references the same table; we cap depth at one
 * in app code (the SQL allows arbitrary depth but the UI never
 * renders past replies). Replies that point at a deeper parent are
 * normalized to the top-level ancestor on insert.
 *
 * Mentions: parsed at write time, stored both inline in `body`
 * (`@[Name](user-id)`) and denormalized into `mentioned_user_ids` so
 * notification fan-out is a single text[] read.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    authorUserId: text('author_user_id').notNull(),
    parentCommentId: uuid('parent_comment_id').references(
      (): AnyPgColumn => comments.id,
      { onDelete: 'set null' },
    ),
    body: text('body').notNull(),
    mentionedUserIds: text('mentioned_user_ids')
      .array()
      .notNull()
      .default([]),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
  },
  (t) => [
    index('comments_tenant_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    index('comments_parent_idx').on(t.parentCommentId, t.createdAt),
    index('comments_tenant_author_idx').on(t.tenantId, t.authorUserId),
    index('comments_tenant_deleted_idx').on(t.tenantId, t.deletedAt),
  ],
);

export const commentsRelations = relations(comments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [comments.tenantId],
    references: [tenants.id],
  }),
}));

export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
