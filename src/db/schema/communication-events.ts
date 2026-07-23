import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { communicationThreads } from './communication-threads';
import { emailMessages } from './email-messages';
import { tenants } from './tenants';

/**
 * Append-only ledger of message-level state transitions. Every send,
 * every bounce, every open/click is one row here. The inbox renders
 * "delivered" / "failed" pills from the latest event per message; the
 * analytics rollup aggregates over the full history.
 *
 * `event_kind` is intentionally a free-text column constrained at the
 * SQL level (CHECK) rather than a Postgres enum, because adding a
 * provider-specific kind shouldn't require a migration.
 *
 * `provider` is also free-text so adding `nodemailer-smtp`,
 * `resend`, `mailgun`, etc. is a config change, not a schema change.
 */
export const COMMUNICATION_EVENT_KINDS = [
  'sent',
  'queued',
  'delivered',
  'failed',
  'retried',
  'opened',
  'clicked',
  'replied',
  'bounced',
  /** An inbound message captured from a connected mailbox (Module 3, Gmail sync). */
  'received',
] as const;
export type CommunicationEventKind =
  (typeof COMMUNICATION_EVENT_KINDS)[number];

export const communicationEvents = pgTable(
  'communication_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => communicationThreads.id, {
      onDelete: 'cascade',
    }),
    messageId: uuid('message_id').references(() => emailMessages.id, {
      onDelete: 'cascade',
    }),
    eventKind: text('event_kind').notNull(),
    provider: text('provider'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('communication_events_thread_idx').on(
      t.tenantId,
      t.threadId,
      t.createdAt,
    ),
    index('communication_events_message_idx').on(
      t.tenantId,
      t.messageId,
      t.createdAt,
    ),
    index('communication_events_tenant_kind_idx').on(
      t.tenantId,
      t.eventKind,
      t.createdAt,
    ),
  ],
);

export const communicationEventsRelations = relations(
  communicationEvents,
  ({ one }) => ({
    thread: one(communicationThreads, {
      fields: [communicationEvents.threadId],
      references: [communicationThreads.id],
    }),
    message: one(emailMessages, {
      fields: [communicationEvents.messageId],
      references: [emailMessages.id],
    }),
  }),
);

export type CommunicationEvent = typeof communicationEvents.$inferSelect;
export type NewCommunicationEvent = typeof communicationEvents.$inferInsert;
