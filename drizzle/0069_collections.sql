-- 0069 — Collections diagnostic (Phase A of the collections addendum).
-- See docs/collections-diagnostic.md.
--
-- PROBLEM
-- Reps are measured on booking; nothing in the CRM records when the customer
-- actually pays. There were no credit terms on deals, proforma invoices were
-- not linked to deals (so not to a rep), carried only free-text payment terms,
-- and no payment was ever recorded. The "credit period vs achievement" report
-- needs all three.
--
-- SHAPE
--   * collection_settings  — the workspace's standard credit period.
--   * deal_credit_terms    — agreed credit days per deal, and who approved a
--                            period longer than standard.
--   * proforma_invoices    — + deal_id (→ owner) and an optional per-invoice
--                            credit-days override. Due date is derived
--                            (invoice date + credit days), never stored, so it
--                            can't drift from the terms it comes from.
--   * invoice_payments     — one row per payment. A partial payment is its own
--                            row, never an overwrite of a "paid" flag.
--
-- ADDITIVE ONLY: three new tables and two nullable columns. No existing row
-- changes. Every existing invoice stays unlinked until someone links it.

CREATE TABLE IF NOT EXISTS "collection_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "standard_credit_days" integer NOT NULL DEFAULT 30,
  "material_excess_days" integer NOT NULL DEFAULT 15,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "collection_settings_days_check" CHECK (
    "standard_credit_days" BETWEEN 0 AND 365 AND "material_excess_days" BETWEEN 0 AND 365
  )
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deal_credit_terms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "agreed_credit_days" integer NOT NULL,
  "agreed_at" timestamptz NOT NULL DEFAULT now(),
  "set_by" text,
  -- Who signed off a period longer than the standard. Cleared whenever the
  -- days change, so an approval can never cover terms nobody approved.
  "approved_by" text,
  "approved_at" timestamptz,
  "note" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "deal_credit_terms_days_check" CHECK ("agreed_credit_days" BETWEEN 0 AND 730),
  CONSTRAINT "deal_credit_terms_approval_pair" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL))
);
--> statement-breakpoint
-- One set of terms per deal.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_credit_terms_deal_unique" ON "deal_credit_terms" ("deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_credit_terms_tenant_idx" ON "deal_credit_terms" ("tenant_id");
--> statement-breakpoint

ALTER TABLE "proforma_invoices"
  ADD COLUMN IF NOT EXISTS "deal_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "proforma_invoices" ADD COLUMN IF NOT EXISTS "credit_days" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "proforma_invoices"
    ADD CONSTRAINT "proforma_invoices_credit_days_check" CHECK ("credit_days" IS NULL OR "credit_days" BETWEEN 0 AND 730);
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoices_tenant_deal_idx"
  ON "proforma_invoices" ("tenant_id", "deal_id") WHERE "deal_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invoice_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "invoice_id" uuid NOT NULL REFERENCES "proforma_invoices"("id") ON DELETE CASCADE,
  "amount_minor" bigint NOT NULL,
  "paid_on" date NOT NULL,
  "reference" text,
  "note" text,
  "recorded_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invoice_payments_amount_positive" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_payments_tenant_invoice_idx" ON "invoice_payments" ("tenant_id", "invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_payments_tenant_paid_on_idx" ON "invoice_payments" ("tenant_id", "paid_on");
--> statement-breakpoint

ALTER TABLE "collection_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_credit_terms" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "collection_settings_tenant_all" ON "collection_settings"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "deal_credit_terms_tenant_all" ON "deal_credit_terms"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "invoice_payments_tenant_all" ON "invoice_payments"
  FOR ALL USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "collection_settings" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "deal_credit_terms" TO "app_user";
--> statement-breakpoint
-- DELETE kept on payments: a mistyped payment has to be removable.
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_payments" TO "app_user";
--> statement-breakpoint
-- 0004's default privileges hand app_user DELETE on every new table; narrow
-- it to what's granted above (see 0068 / 0060 for the same correction).
REVOKE DELETE, TRUNCATE ON "collection_settings", "deal_credit_terms" FROM "app_user";
--> statement-breakpoint
REVOKE TRUNCATE ON "invoice_payments" FROM "app_user";
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format(
        'REVOKE ALL ON "collection_settings", "deal_credit_terms", "invoice_payments" FROM %I',
        r
      );
    END IF;
  END LOOP;
END $$;
