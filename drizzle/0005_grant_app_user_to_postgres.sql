-- Supabase's `postgres` role is not a full Postgres superuser — it has
-- elevated privileges but can't `SET ROLE` to an arbitrary role unless it's
-- explicitly a member of that role. Without this grant, the
-- `SET LOCAL ROLE app_user` inside `tenantTransaction` returns
-- `permission denied to set role "app_user"` (SQLSTATE 42501).
--
-- Granting membership lets postgres switch into app_user for the duration
-- of a transaction. The reverse path — app_user becoming postgres — is
-- still blocked because the grant is one-directional.

GRANT "app_user" TO "postgres";
