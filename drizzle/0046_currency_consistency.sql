-- 0046_currency_consistency.sql
-- Pipeline/deal polish P0-2: kill the "$0.00" artifact on deal cards.
--
-- Root cause: `deals.currency` and `organization_settings.default_currency`
-- both DB-default to 'USD', but this deployment is INR-first (the deal form
-- hardcodes INR). Legacy / bulk-imported deals kept the stray 'USD', so a
-- deal with a zero amount rendered "$0.00" inside an otherwise ₹ workspace.
--
-- Fix: align each workspace's default currency with actual usage, then
-- backfill any deal still on the legacy 'USD' default to its workspace
-- currency so a given workspace renders exactly one currency symbol.
-- Idempotent: after the first run no row is left on the 'USD' default, so a
-- re-run is a no-op.

-- 1. Workspaces still sitting on the unconfigured 'USD' default are treated as
--    INR (the deal form is INR-first for this deployment). A workspace that
--    genuinely wants a non-INR currency can set it explicitly in Settings.
UPDATE "organization_settings"
  SET "default_currency" = 'INR'
  WHERE "default_currency" = 'USD';
--> statement-breakpoint

-- 2. Backfill deals whose currency is the legacy 'USD' default to their
--    workspace's default currency.
UPDATE "deals" d
  SET "currency" = os."default_currency"
  FROM "organization_settings" os
  WHERE d."tenant_id" = os."tenant_id"
    AND d."currency" = 'USD'
    AND os."default_currency" <> 'USD';
--> statement-breakpoint

-- 3. New rows created without an explicit currency should follow the INR-first
--    default rather than the historical 'USD'. The app always sends a currency
--    on create/edit; this just keeps the raw column default honest.
ALTER TABLE "deals" ALTER COLUMN "currency" SET DEFAULT 'INR';
--> statement-breakpoint
ALTER TABLE "organization_settings" ALTER COLUMN "default_currency" SET DEFAULT 'INR';
