-- 0040_deal_unit_pricing.sql
-- Optional per-unit pricing on deals: Amount = unit price x quantity.
-- Gated per workspace by organization_settings.deal_unit_pricing_enabled.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "unit_price_minor" bigint;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "quantity" integer;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "deal_unit_pricing_enabled" boolean NOT NULL DEFAULT false;
