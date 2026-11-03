import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';
import { users } from './users';

/**
 * The link with AskMira (src/lib/askmira, migration 0070). Read and written by
 * the server's own connection only: RLS is on with no policies, so the
 * app_user role a request drops to can never see them.
 */

/** One AskMira workspace per workspace here. The secret is derived, never stored. */
export const askmiraLinks = pgTable('askmira_links', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  askmiraTenantId: uuid('askmira_tenant_id').notNull().unique(),
  askmiraName: text('askmira_name'),
  askmiraOrigin: text('askmira_origin'),
  secretNonce: text('secret_nonce').notNull(),
  connectedBy: text('connected_by'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A one-time code from Allow, swapped by AskMira's server with its PKCE verifier. */
export const askmiraConnectCodes = pgTable('askmira_connect_codes', {
  codeHash: text('code_hash').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  askmiraTenantId: uuid('askmira_tenant_id').notNull(),
  askmiraName: text('askmira_name'),
  askmiraOrigin: text('askmira_origin').notNull(),
  challenge: text('challenge').notNull(),
  approvedBy: text('approved_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

/** Action and sign-in tokens work once: their `jti`, until they expire. */
export const askmiraUsedTokens = pgTable('askmira_used_tokens', {
  jti: text('jti').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Members AskMira manages: linked by email, suspended when they leave in AskMira. */
export const askmiraPeople = pgTable(
  'askmira_people',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    askmiraUserId: text('askmira_user_id'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export type AskmiraLink = typeof askmiraLinks.$inferSelect;
