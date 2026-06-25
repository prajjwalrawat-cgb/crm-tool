-- 0026_app_set_ctx.sql
-- Performance: collapse the per-request RLS context setup into ONE round
-- trip. Previously every RLS-scoped query opened a transaction and issued
-- 3 separate statements (SET LOCAL ROLE app_user + two set_config calls) —
-- ~3 extra network round trips. Over a ~30ms link that was ~90ms of pure
-- overhead per query. This function performs all of it server-side in a
-- single call; `SET LOCAL ROLE` inside the function persists for the
-- surrounding transaction, so RLS still applies exactly as before.
--
-- SECURITY INVOKER (default): runs as the caller (postgres), which is a
-- member of app_user, then drops to app_user. Dropping privilege is never
-- an escalation. All settings are transaction-local (is_local = true /
-- SET LOCAL) so they reset at COMMIT/ROLLBACK — safe under the pooler.

CREATE OR REPLACE FUNCTION app_set_ctx(
  p_tenant text,
  p_user text,
  p_include_deleted boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant, true);
  PERFORM set_config('app.user_id', p_user, true);
  IF p_include_deleted THEN
    PERFORM set_config('app.include_deleted', 'true', true);
  END IF;
  EXECUTE 'SET LOCAL ROLE app_user';
END;
$$;
