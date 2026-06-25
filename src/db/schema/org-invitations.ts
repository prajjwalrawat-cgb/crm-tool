import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { membershipRole } from './enums';
import { tenants } from './tenants';

/**
 * Workspace invitations — the self-hosted replacement for Clerk's
 * organization-invitation list. An admin invites an email at a role; we
 * store a SHA-256 hash of the invite token (raw token only in the link)
 * and the intended role. Accepting the link provisions a membership.
 *
 * Tenant isolation is enforced by always filtering on `tenant_id`
 * explicitly (same pattern as `pending_role_intents`), so this table is
 * read/written via the unrestricted `db` rather than under RLS — the
 * accept flow runs before the invitee has an active tenant context.
 */
export const orgInvitations = pgTable(
  'org_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Invitee email, lower-cased. */
    email: text('email').notNull(),
    role: membershipRole('role').notNull().default('member'),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: text('invited_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('org_invitations_token_hash_unique').on(t.tokenHash),
    index('org_invitations_tenant_idx').on(t.tenantId),
    index('org_invitations_email_idx').on(t.email),
  ],
);

export type OrgInvitation = typeof orgInvitations.$inferSelect;
export type NewOrgInvitation = typeof orgInvitations.$inferInsert;
