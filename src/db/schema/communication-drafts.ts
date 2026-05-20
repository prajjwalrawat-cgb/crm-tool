import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { communicationThreads } from './communication-threads';
import { tenants } from './tenants';

/**
 * Server-authoritative drafts. One row per `(user, context_kind,
 * thread_id-or-null, entity_id-or-null)` — see the UNIQUE expression
 * index in `0017_communications.sql` which uses COALESCE for the
 * nullable keys.
 *
 * `version` is bumped on every server-side write. Clients send their
 * last-seen version with each autosave; the server rejects writes
 * whose version is behind, returns the current row, and the client
 * reconciles. This handles multi-tab and reconnect races.
 *
 * Sending a message DELETEs the draft inside the same transaction
 * that INSERTs into `email_messages` / `communication_threads`.
 */
export const DRAFT_CONTEXT_KINDS = ['new', 'reply', 'forward'] as const;
export type DraftContextKind = (typeof DRAFT_CONTEXT_KINDS)[number];

export const communicationDrafts = pgTable(
  'communication_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Clerk user id of the draft owner. */
    userId: text('user_id').notNull(),

    contextKind: text('context_kind').notNull().default('new'),
    threadId: uuid('thread_id').references(() => communicationThreads.id, {
      onDelete: 'set null',
    }),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    subject: text('subject').notNull().default(''),
    bodyHtml: text('body_html'),
    bodyText: text('body_text').notNull().default(''),

    toRecipients: text('to_recipients').array().notNull().default([]),
    ccRecipients: text('cc_recipients').array().notNull().default([]),
    bccRecipients: text('bcc_recipients').array().notNull().default([]),

    /** Optimistic-concurrency token. Server bumps on every write. */
    version: integer('version').notNull().default(1),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /**
     * Soft-delete tombstone. The send path stamps deleted_at=now()
     * inside the same tx that inserts the message; a nightly cleanup
     * purges rows where deleted_at < now() - 7 days. This avoids the
     * "send raced with a final autosave" data-loss class.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('communication_drafts_user_updated_idx').on(
      t.tenantId,
      t.userId,
      t.updatedAt,
    ),
  ],
);

export const communicationDraftsRelations = relations(
  communicationDrafts,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [communicationDrafts.tenantId],
      references: [tenants.id],
    }),
    thread: one(communicationThreads, {
      fields: [communicationDrafts.threadId],
      references: [communicationThreads.id],
    }),
  }),
);

export type CommunicationDraft = typeof communicationDrafts.$inferSelect;
export type NewCommunicationDraft = typeof communicationDrafts.$inferInsert;
