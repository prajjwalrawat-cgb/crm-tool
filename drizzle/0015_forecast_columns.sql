-- Phase: forecast columns on deals (CP#14 step 6 — Revenue Forecast)
--
-- Adds a per-deal `probability` (0-100) used to compute weighted
-- forecasts: sum(amount_minor * probability / 100) over open deals
-- closing in a window. The probability column is nullable to let
-- migrations roll forward safely; backfill below stamps stage-derived
-- defaults.
--
-- Why stage-derived defaults instead of "everyone starts at 0":
-- nobody enters a stage like 'proposal' expecting a 0% close. A
-- baseline that comes from the stage gives an immediately useful
-- forecast — reps + admins can override later for any specific deal.

ALTER TABLE "deals"
  ADD COLUMN IF NOT EXISTS "probability" smallint
    CHECK ("probability" >= 0 AND "probability" <= 100);
--> statement-breakpoint

-- Backfill probability from stage. Won = 100, lost = 0, the middle
-- stages get conservative-ish defaults that match typical pipeline
-- coaching language. NULL-only update so re-running the migration
-- doesn't clobber any manual overrides set later.
UPDATE "deals"
SET "probability" = CASE "stage"
  WHEN 'lead'        THEN 10
  WHEN 'qualified'   THEN 25
  WHEN 'proposal'    THEN 50
  WHEN 'negotiation' THEN 75
  WHEN 'won'         THEN 100
  WHEN 'lost'        THEN 0
  ELSE 25
END
WHERE "probability" IS NULL;
--> statement-breakpoint

-- Index for the forecast scan: open deals (non-terminal stages) with
-- a forecast horizon (expected_close_date), partial so the index
-- stays tiny — terminal stages never participate in forecasting.
CREATE INDEX IF NOT EXISTS "deals_forecast_idx"
  ON "deals" USING btree (
    "tenant_id",
    "expected_close_date"
  )
  WHERE "deleted_at" IS NULL
    AND "stage" IN ('lead', 'qualified', 'proposal', 'negotiation');
