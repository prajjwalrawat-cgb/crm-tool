-- Phase: analytics layer (CP#14) — supporting indexes only.
--
-- Three indexes, each justified by one or more report queries:
--
--   1. deals(tenant_id, stage, closed_at) WHERE deleted_at IS NULL
--      Powers the Win/Loss Rate report — every closed-deal report
--      filters by stage IN ('won','lost') and a closed_at window.
--      The partial keeps the index tiny (only ~5-15% of rows are
--      typically closed) and excludes soft-deletes that the runtime
--      hides anyway.
--
--   2. activity_logs(tenant_id, entity_type, entity_id, created_at DESC)
--      Powers the Stale Deals "last activity per deal" CTE. The
--      existing per-entity index already covers timeline queries;
--      this re-creates it with the explicit DESC ordering so the
--      max(created_at) GROUP BY can use an index-only scan.
--
--   3. email_messages(tenant_id, entity_type, entity_id, created_at DESC)
--      WHERE direction='outbound' AND status IN ('sent','delivered')
--      Powers the Stale Deals "last successful outbound email per
--      deal" CTE. Partial filter on the success states keeps the
--      index small.
--
-- CREATE INDEX IF NOT EXISTS used everywhere so the migration is
-- idempotent — applying twice doesn't error.

CREATE INDEX IF NOT EXISTS "deals_tenant_stage_closed_at_idx"
  ON "deals" USING btree ("tenant_id", "stage", "closed_at")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "activity_logs_tenant_entity_created_desc_idx"
  ON "activity_logs" USING btree (
    "tenant_id",
    "entity_type",
    "entity_id",
    "created_at" DESC
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_messages_tenant_entity_sent_desc_idx"
  ON "email_messages" USING btree (
    "tenant_id",
    "entity_type",
    "entity_id",
    "created_at" DESC
  )
  WHERE "direction" = 'outbound' AND "status" IN ('sent', 'delivered');
