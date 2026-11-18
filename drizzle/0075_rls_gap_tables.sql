-- 0075_rls_gap_tables.sql
--
-- Security prerequisite. Six tenant tables were created before the RLS
-- convention (or deliberately left out of it) and are scoped only by an
-- explicit `WHERE tenant_id = ?` in app code:
--
--   sales_targets, custom_field_definitions, invoice_seller_profiles,
--   chart_views, dashboard_widgets, org_invitations
--
-- This migration gives them the same four tenant policies as every other
-- tenant table (0050 / 0058 / 0060 / 0061 / 0062 pattern: ENABLE + FORCE,
-- `tenant_id::text = current_setting('app.tenant_id', true)`, grants to
-- app_user). App code reaches them through tenantTransaction (app_set_ctx).
--
-- org_invitations is read once BEFORE a tenant context exists: the invitee
-- opens /accept-invite or /sign-up with a raw token. That lookup goes through
-- `org_invitation_by_token(text)`, a SECURITY DEFINER function that returns
-- at most one row, by token hash, and only while the invite is unaccepted and
-- unexpired (same shape as 0072's lead_source_public_lookup). Everything after
-- the lookup (marking it accepted) runs under the invite's tenant context.
--
-- Second part: the app never uses the Supabase Data API (PostgREST). All
-- reads go through the postgres connection, and Storage uses the service
-- role. So anon and authenticated get no privileges on anything in public:
-- tables, sequences or functions (Supabase's default privileges grant all
-- three, which would expose e.g. users.password_hash and let anon call the
-- SECURITY DEFINER lookups over /rpc). Default privileges are revoked too,
-- so tables created by later migrations are not exposed.
--
-- Idempotent: safe to replay on every deploy.

-- ---------------------------------------------------------------------------
-- 1. Tenant policies on the six tables
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales_targets',
    'custom_field_definitions',
    'invoice_seller_profiles',
    'chart_views',
    'dashboard_widgets',
    'org_invitations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t || '_tenant_select', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t || '_tenant_insert', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t || '_tenant_update', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t || '_tenant_delete', t);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Pre-tenant invite lookup. One row by token hash, only while usable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "org_invitation_by_token"(p_token_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  email text,
  role membership_role,
  invited_by_user_id text,
  expires_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id, i.email, i.role, i.invited_by_user_id,
         i.expires_at, i.accepted_at, i.created_at, i.updated_at
  FROM org_invitations i
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL
    AND i.expires_at > now()
  LIMIT 1;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "org_invitation_by_token"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "org_invitation_by_token"(text) TO app_user;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. No Data API exposure: strip anon / authenticated from public.
--    Guarded so plain Postgres (local test DB, CI) without the Supabase roles
--    still applies cleanly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      -- Future objects created by this migration role (postgres on Supabase).
      BEGIN
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'could not alter default privileges for %, revoke them in the Supabase dashboard', r;
      END;
    END IF;
  END LOOP;
END $$;
