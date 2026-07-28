-- 0055_deal_value_splits.sql
-- Multi-year TCV. A deal carries ONE amount (the total contract value), but a
-- contract may run several years — this records how that total breaks down per
-- contract year.
--
-- Record-and-report only by design: `deals.amount_minor` stays the TCV and
-- remains the single figure the board, forecast and targets read, so nothing
-- existing re-baselines. The split is display + export.
--
-- Rows are contract years derived from a start date: year 1 begins on the
-- contract start, each subsequent year on its anniversary. Amounts are per
-- year and must sum to the deal's amount (enforced in the action).
-- Currency is NOT stored here — a split always inherits `deals.currency`.

CREATE TABLE IF NOT EXISTS "deal_value_splits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- 1-based contract year. Year 1 = the year starting on the contract start.
  "year_index" smallint NOT NULL,
  -- Inclusive start / exclusive-of-the-next-year end for this contract year.
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "amount_minor" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per contract year per deal; the UI rewrites the whole set on save.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_value_splits_deal_year_uniq"
  ON "deal_value_splits" ("deal_id", "year_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_value_splits_tenant_deal_idx"
  ON "deal_value_splits" ("tenant_id", "deal_id");
--> statement-breakpoint

-- Guard rails the app also enforces, kept here so bad rows can't be written
-- around the action.
ALTER TABLE "deal_value_splits"
  DROP CONSTRAINT IF EXISTS "deal_value_splits_year_index_positive";
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD CONSTRAINT "deal_value_splits_year_index_positive"
  CHECK ("year_index" >= 1);
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  DROP CONSTRAINT IF EXISTS "deal_value_splits_period_ordered";
--> statement-breakpoint
ALTER TABLE "deal_value_splits"
  ADD CONSTRAINT "deal_value_splits_period_ordered"
  CHECK ("period_end" > "period_start");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0045 / 0049 / 0050.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_value_splits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_value_splits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS "deal_value_splits_tenant_select" ON "deal_value_splits";
--> statement-breakpoint
CREATE POLICY "deal_value_splits_tenant_select" ON "deal_value_splits"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_value_splits_tenant_insert" ON "deal_value_splits";
--> statement-breakpoint
CREATE POLICY "deal_value_splits_tenant_insert" ON "deal_value_splits"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_value_splits_tenant_update" ON "deal_value_splits";
--> statement-breakpoint
CREATE POLICY "deal_value_splits_tenant_update" ON "deal_value_splits"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_value_splits_tenant_delete" ON "deal_value_splits";
--> statement-breakpoint
CREATE POLICY "deal_value_splits_tenant_delete" ON "deal_value_splits"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_value_splits" TO "app_user";
