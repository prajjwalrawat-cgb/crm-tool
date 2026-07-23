import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-user Gmail connection (Module 3). One row per (tenant, user) — each rep
 * connects their OWN mailbox. Refresh tokens are stored AES-256-GCM encrypted
 * (see `src/lib/email/gmail/crypto.ts`); the plaintext token never touches the
 * DB or logs. `historyId` drives Gmail incremental `history.list` sync.
 */
export const GMAIL_SYNC_STATUSES = ['active', 'error', 'disconnected'] as const;
export type GmailSyncStatus = (typeof GMAIL_SYNC_STATUSES)[number];

export const gmailConnections = pgTable(
  'gmail_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** CRM user id (text) who owns this mailbox connection. */
    userId: text('user_id').notNull(),
    /** The connected Gmail address (lowercased). */
    email: text('email').notNull(),
    /** AES-256-GCM ciphertext of the OAuth refresh token. Never plaintext. */
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    /** AES-256-GCM ciphertext of the short-lived access token (optional cache). */
    accessTokenEnc: text('access_token_enc'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
    }),
    /** Gmail history cursor for incremental sync; null → do a windowed first sync. */
    historyId: text('history_id'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    syncStatus: text('sync_status').notNull().default('active'),
    lastError: text('last_error'),
    /** Per-user never-sync lists. Domains + explicit addresses. */
    excludedDomains: text('excluded_domains').array().notNull().default([]),
    excludedAddresses: text('excluded_addresses').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    /** Reserved for future config (label filters, etc.). */
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [
    uniqueIndex('gmail_connections_tenant_user_uniq').on(t.tenantId, t.userId),
    index('gmail_connections_tenant_status_idx').on(t.tenantId, t.syncStatus),
  ],
);

export const gmailConnectionsRelations = relations(
  gmailConnections,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [gmailConnections.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type GmailConnection = typeof gmailConnections.$inferSelect;
export type NewGmailConnection = typeof gmailConnections.$inferInsert;
