-- 0047_stage_probabilities.sql
-- Pipeline polish P1-7: per-stage win probability, used to render weighted
-- pipeline value (Σ amount × stage probability) beneath each board column's
-- raw total. NULL = fall back to the code defaults in
-- lib/deals/stage-probability.ts. Configurable in Settings → Pipeline.
ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "stage_probabilities" jsonb;
