import { relations } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { communicationThreads } from './communication-threads';
import { contacts } from './contacts';
import { tenants } from './tenants';

/**
 * One row per (thread, address, role). De-dups CC repeats and lets
 * the inbox render an avatar strip without joining `email_messages`.
 *
 * `contact_id` is nullable — we receive mail from addresses that
 * don't match any CRM contact, and we still thread them. When a
 * contact is later created with that email, a backfill job stamps
 * the `contact_id` retroactively.
 */
export const PARTICIPANT_ROLES = ['from', 'to', 'cc', 'bcc'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const communicationParticipants = pgTable(
  'communication_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => communicationThreads.id, { onDelete: 'cascade' }),
    emailAddress: text('email_address').notNull(),
    participantRole: text('participant_role').notNull(),
    contactId: uuid('contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('communication_participants_unique').on(
      t.tenantId,
      t.threadId,
      t.emailAddress,
      t.participantRole,
    ),
    index('communication_participants_thread_idx').on(
      t.tenantId,
      t.threadId,
    ),
    index('communication_participants_address_idx').on(
      t.tenantId,
      t.emailAddress,
    ),
  ],
);

export const communicationParticipantsRelations = relations(
  communicationParticipants,
  ({ one }) => ({
    thread: one(communicationThreads, {
      fields: [communicationParticipants.threadId],
      references: [communicationThreads.id],
    }),
    contact: one(contacts, {
      fields: [communicationParticipants.contactId],
      references: [contacts.id],
    }),
  }),
);

export type CommunicationParticipant =
  typeof communicationParticipants.$inferSelect;
export type NewCommunicationParticipant =
  typeof communicationParticipants.$inferInsert;
