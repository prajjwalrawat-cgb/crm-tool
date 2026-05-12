import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Free-form notes attached to a deal / company / contact. Renders as a
 * timeline on each entity's detail page. Notes are kept distinct from
 * activity_logs by design:
 *   - activity_logs is an audit stream — system + user actions, terse,
 *     append-only, never edited.
 *   - notes is human content — long-form, editable, deletable, the
 *     "memory" of the CRM (call summaries, intel, next steps).
 *
 * Both are surfaced together in the entity detail timeline but rendered
 * with different chrome so users see the difference at a glance.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** Clerk user id of the author. */
    authorUserId: text('author_user_id').notNull(),
    /** 'deal' | 'company' | 'contact'. Required — notes are always linked. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
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
    // Detail-page timeline lookup: per-entity, newest first.
    index('notes_tenant_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    index('notes_tenant_author_idx').on(t.tenantId, t.authorUserId),
    index('notes_tenant_deleted_idx').on(t.tenantId, t.deletedAt),
  ],
);

export const notesRelations = relations(notes, ({ one }) => ({
  tenant: one(tenants, {
    fields: [notes.tenantId],
    references: [tenants.id],
  }),
}));

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
