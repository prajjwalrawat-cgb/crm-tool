-- Phase 17-E: DB-backed app-role intent for invitations.
--
-- Clerk's built-in org roles are admin/member only — there's no
-- 'manager' role. Phase 17 carries the manager intent via Clerk's
-- invitation publicMetadata, but that round-trip is fragile (metadata
-- can be missing/stripped, list endpoints may delay updates, and
-- there's a race between Clerk webhook delivery and the user's
-- first dashboard load).
--
-- This table is the canonical DB-backed source of "what role should
-- this invited email get when they accept?". Written at invite time,
-- read by `resolveAppRoleForJoin` at membership-creation time, then
-- deleted once the membership has been provisioned with the right
-- role.
--
-- Keyed by (tenant_id, email_lc) so re-inviting the same email at a
-- different role simply overwrites the prior intent. Not RLS-scoped
-- — the resolver runs in a system context during webhook + first-
-- dashboard-load flows where the actor's tenant is already known.
-- Tenant isolation is enforced by the (tenant_id, email_lc) primary
-- key + the resolver's lookup-by-tenant query.

CREATE TABLE IF NOT EXISTS pending_role_intents (
  tenant_id       uuid       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email_lc        text       NOT NULL,
  app_role        membership_role NOT NULL,
  invitation_id   text,
  inviter_user_id text       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email_lc)
);

-- Lookup index used by the cleanup-on-removal path.
CREATE INDEX IF NOT EXISTS pending_role_intents_email_idx
  ON pending_role_intents (email_lc);
