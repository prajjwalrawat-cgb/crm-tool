import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-user, per-entity working drafts. Cleared when the corresponding
 * email is sent. RLS scopes reads to the author so users only see
 * their own drafts.
 *
 * v1 UI doesn't autosave; the table exists so the compose drawer
 * could later persist work-in-progress across page reloads.
 */
export const emailDrafts = pgTable(
  'email_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    subject: text('subject').notNull().default(''),
    textBody: text('text_body').notNull().default(''),
    toRecipients: text('to_recipients').array().notNull().default([]),
    ccRecipients: text('cc_recipients').array().notNull().default([]),
    bccRecipients: text('bcc_recipients').array().notNull().default([]),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('email_drafts_tenant_author_idx').on(
      t.tenantId,
      t.actorUserId,
      t.updatedAt,
    ),
    index('email_drafts_tenant_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
  ],
);

export const emailDraftsRelations = relations(emailDrafts, ({ one }) => ({
  tenant: one(tenants, {
    fields: [emailDrafts.tenantId],
    references: [tenants.id],
  }),
}));

export type EmailDraft = typeof emailDrafts.$inferSelect;
export type NewEmailDraft = typeof emailDrafts.$inferInsert;
