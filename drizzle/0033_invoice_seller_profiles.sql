-- 0033_invoice_seller_profiles.sql
-- Per-state seller profiles (one company, multiple GSTINs by state). Owner
-- fills a profile per state; members pick the state on the PI form.
CREATE TABLE IF NOT EXISTS "invoice_seller_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "state_code" text NOT NULL,
  "seller_name" text NOT NULL,
  "address" text,
  "gstin" text,
  "pan" text,
  "cin" text,
  "bank_name" text,
  "bank_account" text,
  "bank_ifsc" text,
  "bank_branch" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_seller_profiles_tenant_state_uq"
  ON "invoice_seller_profiles" ("tenant_id", "state_code");
--> statement-breakpoint
-- Migrate any existing single-seller settings into a per-state profile,
-- deriving the state from the GSTIN prefix (first 2 chars).
INSERT INTO "invoice_seller_profiles"
  ("tenant_id", "state_code", "seller_name", "address", "gstin", "pan", "cin",
   "bank_name", "bank_account", "bank_ifsc", "bank_branch")
SELECT os."tenant_id",
       LEFT(os."invoice_gstin", 2),
       os."invoice_seller_name",
       os."invoice_seller_address", os."invoice_gstin", os."invoice_pan", os."invoice_cin",
       os."invoice_bank_name", os."invoice_bank_account", os."invoice_bank_ifsc", os."invoice_bank_branch"
FROM "organization_settings" os
WHERE os."invoice_seller_name" IS NOT NULL
  AND os."invoice_gstin" IS NOT NULL
  AND LENGTH(os."invoice_gstin") >= 2
ON CONFLICT ("tenant_id", "state_code") DO NOTHING;
