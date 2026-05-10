-- Phase: Row-Level Security
--
-- Tenant isolation is now defense-in-depth: we keep the explicit
-- `WHERE tenant_id = ?` predicates in app queries (they remain a sanity layer
-- *and* let the planner pick the existing (tenant_id, …) composite indexes),
-- but rows are also filtered by RLS policies that read the active tenant from
-- a request-scoped GUC (`app.tenant_id`).
--
-- Policies use `current_setting('app.tenant_id', true)` — the second arg is
-- "missing_ok = true" so an unset GUC returns NULL instead of erroring. The
-- equality comparison with NULL evaluates to NULL (not TRUE), so policies
-- *fail closed* when no context is established. There is no fallback path to
-- "see everything" — a forgotten context is equivalent to "see nothing".
--
-- `app.include_deleted` is a separate GUC that opts-in to seeing soft-deleted
-- rows in the SELECT policy. Set only by the recently-deleted page.
--
-- We FORCE row level security so the policies apply to the table owner too —
-- our app's connection runs as `postgres`, which is the table owner and would
-- otherwise bypass RLS by default.
--
-- The `tenants` table itself is intentionally NOT RLS-protected. Tenant
-- bootstrap (clerk-org → tenant lookup, tenant creation in webhooks) happens
-- *before* a session has an active tenant id, so making the table RLS-scoped
-- would be a chicken-and-egg problem. The fields it carries (name, slug,
-- clerk_org_id) are not cross-tenant-sensitive on their own.

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "activity_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_logs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- =============================================================================
-- memberships: tenant scoping (no soft-delete on this table)
-- =============================================================================
CREATE POLICY "memberships_tenant_select" ON "memberships"
  FOR SELECT
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "memberships_tenant_insert" ON "memberships"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "memberships_tenant_update" ON "memberships"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "memberships_tenant_delete" ON "memberships"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- =============================================================================
-- companies: tenant scoping + soft-delete hidden by default
-- =============================================================================
CREATE POLICY "companies_tenant_select" ON "companies"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "companies_tenant_insert" ON "companies"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "companies_tenant_update" ON "companies"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "companies_tenant_delete" ON "companies"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- =============================================================================
-- contacts: tenant scoping + soft-delete hidden by default
-- =============================================================================
CREATE POLICY "contacts_tenant_select" ON "contacts"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "contacts_tenant_insert" ON "contacts"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "contacts_tenant_update" ON "contacts"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "contacts_tenant_delete" ON "contacts"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- =============================================================================
-- deals: tenant scoping + soft-delete hidden by default
-- =============================================================================
CREATE POLICY "deals_tenant_select" ON "deals"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND (
      deleted_at IS NULL
      OR current_setting('app.include_deleted', true) = 'true'
    )
  );
--> statement-breakpoint
CREATE POLICY "deals_tenant_insert" ON "deals"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deals_tenant_update" ON "deals"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deals_tenant_delete" ON "deals"
  FOR DELETE
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- =============================================================================
-- activity_logs: tenant scoping; logs are append-only in practice
-- =============================================================================
CREATE POLICY "activity_logs_tenant_select" ON "activity_logs"
  FOR SELECT
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "activity_logs_tenant_insert" ON "activity_logs"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- We don't expose update/delete policies on activity_logs by design — there's
-- no app code path that mutates audit history, so the absence of UPDATE/DELETE
-- policies under FORCE RLS makes those operations impossible from the app
-- connection. If a future feature legitimately needs to redact a log entry,
-- add the policy explicitly.
