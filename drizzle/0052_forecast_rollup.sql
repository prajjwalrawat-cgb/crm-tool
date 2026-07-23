-- 0052_forecast_rollup.sql
-- Phase 2 / Module 4 (Forecast Rollup). Forecast-category columns on deals +
-- the append-only weekly forecast_snapshots table.

-- ---------------------------------------------------------------------------
-- deals: forecast category + override flag.
-- ---------------------------------------------------------------------------
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "forecast_category" text;
--> statement-breakpoint
ALTER TABLE "deals"
  ADD COLUMN IF NOT EXISTS "forecast_category_overridden" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill the derived category for existing deals (only where unset). Mirrors
-- deriveForecastCategory() in src/lib/deals/forecast/categories.ts.
UPDATE "deals" SET "forecast_category" = CASE "stage"
    WHEN 'lead' THEN 'pipeline'
    WHEN 'qualified' THEN 'pipeline'
    WHEN 'proposal' THEN 'best_case'
    WHEN 'negotiation' THEN 'commit'
    WHEN 'won' THEN 'closed_won'
    ELSE 'omitted'
  END
  WHERE "forecast_category" IS NULL;
--> statement-breakpoint
-- Supports the forecast matrix (WHERE tenant_id = ? AND forecast_category = ?).
CREATE INDEX IF NOT EXISTS "deals_tenant_forecast_cat_idx"
  ON "deals" ("tenant_id", "forecast_category");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- forecast_snapshots: weekly capture for week-over-week deltas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "forecast_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "period" text NOT NULL,
  "owner_id" text,
  "category" text NOT NULL,
  "total_amount" bigint NOT NULL DEFAULT 0,
  "deal_count" integer NOT NULL DEFAULT 0,
  "captured_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forecast_snapshots_tenant_period_idx"
  ON "forecast_snapshots" ("tenant_id", "period", "captured_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0049–0051.
-- ---------------------------------------------------------------------------
ALTER TABLE "forecast_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "forecast_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "forecast_snapshots_tenant_select" ON "forecast_snapshots"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "forecast_snapshots_tenant_insert" ON "forecast_snapshots"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "forecast_snapshots_tenant_update" ON "forecast_snapshots"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "forecast_snapshots_tenant_delete" ON "forecast_snapshots"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "forecast_snapshots" TO "app_user";
