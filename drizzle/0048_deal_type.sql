-- 0048_deal_type.sql
-- Pipeline polish P1-9: a deal classification used to disambiguate same-named
-- opportunities on the board (e.g. "Safeops 360 — Renewal" vs "— New Logo").
DO $$ BEGIN
  CREATE TYPE "deal_type" AS ENUM ('new_logo', 'renewal', 'expansion', 'upsell');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "deal_type" "deal_type";
