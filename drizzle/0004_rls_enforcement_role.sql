-- The RLS policies from 0003 only fire for non-superuser roles. Supabase's
-- `postgres` role (our connection user) is a superuser and bypasses RLS
-- regardless of `FORCE ROW LEVEL SECURITY`. To actually exercise the
-- policies, every tenant-scoped transaction inside the app does a
-- `SET LOCAL ROLE app_user` — dropping privileges to a role that has
-- table-level grants but is *not* the owner and *does not* have SUPERUSER.
--
-- `SET LOCAL ROLE` reverts at COMMIT/ROLLBACK, so this is safe under
-- Supabase's transaction-mode pooler — the connection returns to the pool
-- as `postgres` with no leftover state.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOINHERIT NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA "public" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "tenants",
     "memberships",
     "companies",
     "contacts",
     "deals",
     "activity_logs"
  TO "app_user";
--> statement-breakpoint
-- gen_random_uuid() and $onUpdate-fed timestamps don't need sequence access
-- right now, but we grant it so future serial/identity columns Just Work.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "app_user";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_user";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
  GRANT USAGE, SELECT ON SEQUENCES TO "app_user";
