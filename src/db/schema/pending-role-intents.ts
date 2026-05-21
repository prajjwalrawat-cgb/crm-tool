import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { membershipRole } from './enums';
import { tenants } from './tenants';

/**
 * Pending role intent — DB-backed source of "what role should this
 * invited email get when they accept?". Written by the invite action,
 * read by `resolveAppRoleForJoin` at membership-creation time, then
 * deleted by the same code once the membership row is provisioned
 * with the correct role.
 *
 * This eliminates the Clerk-metadata round-trip fragility — managers
 * are a CRM-app concept (Clerk's built-in org roles are admin/member
 * only) and storing the intent in our own DB makes the propagation
 * deterministic instead of depending on Clerk's invitation list API
 * returning publicMetadata reliably.
 *
 * Re-inviting the same email at a different role simply overwrites
 * the prior intent (PK conflict → update). Removing a member also
 * clears any lingering intent for that email so a re-invite starts
 * from a clean slate.
 */
export const pendingRoleIntents = pgTable(
  'pending_role_intents',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    emailLc: text('email_lc').notNull(),
    appRole: membershipRole('app_role').notNull(),
    invitationId: text('invitation_id'),
    inviterUserId: text('inviter_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.emailLc] }),
    index('pending_role_intents_email_idx').on(t.emailLc),
  ],
);

export type PendingRoleIntent = typeof pendingRoleIntents.$inferSelect;
export type NewPendingRoleIntent = typeof pendingRoleIntents.$inferInsert;
