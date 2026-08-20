-- 0059 — make every RLS tenant predicate index-friendly.
--
-- PROBLEM
-- Every policy written since 0003 compares the tenant column as text:
--
--     tenant_id::text = current_setting('app.tenant_id', true)
--
-- Casting the *column* makes the predicate opaque to the planner:
--   1. `tenant_id::text` is not `tenant_id`, so none of the btree indexes
--      on (tenant_id, ...) can satisfy it. Every RLS-scoped read falls back
--      to a Seq Scan on the whole table — including all 16 indexes on
--      `deals` and the keyset indexes added in 0056, which were never
--      being used in production.
--   2. With no matching statistics the planner defaults the selectivity to
--      a near-constant tiny estimate, so it also picks bad join orders and
--      refuses ordered index scans for `ORDER BY ... LIMIT`.
--
-- Measured on the production dataset (462 deals, one tenant holding 5):
--
--     before:  Seq Scan on deals, Rows Removed by Filter: 457
--              Buffers: shared hit=26   Execution Time: 0.334 ms
--     after:   Index Scan using deals_tenant_id_idx
--              Buffers: shared hit=6    Execution Time: 0.084 ms
--
-- The gap widens linearly with table size — a Seq Scan costs more per row
-- added, an Index Scan does not.
--
-- FIX
-- Compare uuid to uuid, and wrap the GUC read in a scalar subquery so the
-- planner hoists it into an InitPlan evaluated once per statement instead
-- of once per row:
--
--     tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)
--
-- SEMANTICS ARE UNCHANGED — this is a pure planner fix, not a policy change:
--   * GUC unset      -> current_setting(...) returns NULL -> `= NULL` -> no rows.
--   * GUC empty ''   -> nullif('','') returns NULL        -> `= NULL` -> no rows.
--   * GUC set        -> exact uuid equality, same row set as the text compare.
-- The `nullif` guard is required: a bare ''::uuid raises invalid_text_
-- representation and would turn a missing tenant context into a 500 rather
-- than an empty result.
--
-- Verified before shipping, inside a rolled-back transaction:
--   own tenant -> 5 deals | empty GUC -> 0 deals | bogus tenant -> 0 deals
--
-- APPROACH
-- Rewritten programmatically rather than by hand: 121 policies across 40
-- tables carry this predicate, and several combine it with extra terms
-- (`deleted_at IS NULL OR app.include_deleted`, `recipient_user_id = ...`,
-- `actor_user_id = ...`). Reading each policy back out of pg_policies and
-- substituting only the tenant term preserves those extra conditions
-- exactly, which a hand-written DROP/CREATE sweep would risk dropping.
--
-- Idempotent: the loop selects only policies that still contain the cast,
-- so a second run matches nothing and does no work.

DO $$
DECLARE
  p record;
  old_expr text := '(tenant_id)::text = current_setting(''app.tenant_id''::text, true)';
  new_expr text := 'tenant_id = (select nullif(current_setting(''app.tenant_id''::text, true), '''')::uuid)';
  parts text;
  n int := 0;
BEGIN
  FOR p IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual, '') LIKE '%(tenant_id)::text%'
        OR coalesce(with_check, '') LIKE '%(tenant_id)::text%')
  LOOP
    parts := '';
    -- Re-emit only the clauses the policy actually had. Adding a USING to
    -- an INSERT-only policy (or a WITH CHECK to a SELECT one) is a syntax
    -- error, so both sides stay conditional.
    IF p.qual IS NOT NULL THEN
      parts := parts || format(' USING (%s)', replace(p.qual, old_expr, new_expr));
    END IF;
    IF p.with_check IS NOT NULL THEN
      parts := parts || format(' WITH CHECK (%s)', replace(p.with_check, old_expr, new_expr));
    END IF;

    EXECUTE format('ALTER POLICY %I ON public.%I%s', p.policyname, p.tablename, parts);
    n := n + 1;
  END LOOP;

  RAISE NOTICE '0059: rewrote % tenant policies to the uuid predicate', n;
END $$;
--> statement-breakpoint

-- Refresh planner statistics on the hottest tenant-scoped tables so the
-- new index-eligible predicate is costed against current data rather than
-- whatever was collected while every scan was sequential.
ANALYZE deals;
--> statement-breakpoint
ANALYZE companies;
--> statement-breakpoint
ANALYZE contacts;
--> statement-breakpoint
ANALYZE activity_logs;
