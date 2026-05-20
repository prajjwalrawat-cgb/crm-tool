import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

export const EMAIL_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_DIRECTIONS = ['outbound', 'inbound'] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];

export const EMAIL_PROVIDERS = [
  'resend',
  'smtp',
  'console',
  'gmail',
  'outlook',
] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

/**
 * Outbound (and reserved-inbound) email log. Every send writes a row
 * BEFORE the provider is called (status='queued'), then transitions
 * through 'sending' to either 'sent' or 'failed'. That ordering lets
 * the timeline render the event the moment the user clicks Send;
 * provider latency stays out of the user-perceived path.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    provider: text('provider').notNull(),
    direction: text('direction').notNull().default('outbound'),
    status: text('status').notNull().default('queued'),
    subject: text('subject').notNull(),
    htmlBody: text('html_body'),
    textBody: text('text_body').notNull(),
    sender: text('sender').notNull(),
    toRecipients: text('to_recipients').array().notNull().default([]),
    ccRecipients: text('cc_recipients').array().notNull().default([]),
    bccRecipients: text('bcc_recipients').array().notNull().default([]),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /**
     * Link into `communication_threads`. Nullable so existing rows
     * are valid pre-backfill; new sends populate it inline. The
     * inbox never reads `email_messages` on the hot path — it scans
     * threads — so this column is mostly for per-message audits.
     */
    threadId: uuid('thread_id'),
    providerMessageId: text('provider_message_id'),
    idempotencyKey: text('idempotency_key'),
    error: text('error'),
    retryCount: integer('retry_count').notNull().default(0),
    metadata: jsonb('metadata').notNull().default({}),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('email_messages_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('email_messages_tenant_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    index('email_messages_tenant_actor_idx').on(t.tenantId, t.actorUserId),
    index('email_messages_tenant_status_idx').on(t.tenantId, t.status),
    // The partial unique index `email_messages_idempotency_idx`
    // (WHERE idempotency_key IS NOT NULL) is declared in the
    // migration SQL — Drizzle's index builder doesn't model partial
    // unique indexes, but the runtime queries don't need to see
    // them either since we never select on idempotency_key alone.
  ],
);

export const emailMessagesRelations = relations(emailMessages, ({ one }) => ({
  tenant: one(tenants, {
    fields: [emailMessages.tenantId],
    references: [tenants.id],
  }),
}));

export type EmailMessage = typeof emailMessages.$inferSelect;
export type NewEmailMessage = typeof emailMessages.$inferInsert;
