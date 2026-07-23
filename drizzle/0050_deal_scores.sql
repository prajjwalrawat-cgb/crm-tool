-- 0050_deal_scores.sql
-- Phase 2 / Module 2 (Deal Health Score). Append-only score history table plus
-- two derived "current score" cache columns on deals so the board and the
-- pipeline Score filter are cheap single-column reads. The append-only
-- deal_scores table remains the source of truth (and the trend-line source);
-- deals.health_score / health_band are a denormalized cache the recompute
-- service keeps in lockstep.

-- ---------------------------------------------------------------------------
-- deal_scores: one row per recompute (append-only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "deal_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "score" smallint NOT NULL,
  "band" text NOT NULL,
  "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_scores_deal_computed_idx"
  ON "deal_scores" ("deal_id", "computed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_scores_tenant_deal_idx"
  ON "deal_scores" ("tenant_id", "deal_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- deals: denormalized current score cache (nullable until first recompute).
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "health_score" smallint;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "health_band" text;
--> statement-breakpoint
-- Supports the pipeline Score filter (WHERE tenant_id = ? AND health_band = ?).
CREATE INDEX IF NOT EXISTS "deals_tenant_health_band_idx"
  ON "deals" ("tenant_id", "health_band");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0045 / 0049.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_scores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "deal_scores_tenant_select" ON "deal_scores"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_scores_tenant_insert" ON "deal_scores"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_scores_tenant_update" ON "deal_scores"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "deal_scores_tenant_delete" ON "deal_scores"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_scores" TO "app_user";
