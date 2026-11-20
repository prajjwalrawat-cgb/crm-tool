-- 0078_quotes.sql
--
-- Quote builder: tenant-built quote formats, per-deal quotes with revisions,
-- line items, and per-tenant numbering.
--
--   quote_settings          one row per tenant: number format + default validity
--   quote_number_sequences  last issued number per (tenant, fiscal year)
--   quote_templates         tenant-built formats; body = { theme, sections }
--   quotes                  a quote on a deal; money in paise, rates in bps
--   quote_items             line items of a quote
--
-- All are tenant tables with ENABLE + FORCE RLS and the four standard tenant
-- policies (same loop as 0077), granted to app_user, nothing to anon /
-- authenticated.
--
-- Idempotent: safe to replay on every deploy.

DO $$ BEGIN
  CREATE TYPE "quote_status" AS ENUM ('draft', 'sent', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quote_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "number_prefix" text NOT NULL DEFAULT 'Q',
  "number_separator" text NOT NULL DEFAULT '/',
  "number_include_fy" boolean NOT NULL DEFAULT true,
  "number_padding" smallint NOT NULL DEFAULT 4,
  "default_validity_days" integer NOT NULL DEFAULT 30,
  "updated_by" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "quote_settings_padding_check" CHECK ("number_padding" BETWEEN 1 AND 8),
  CONSTRAINT "quote_settings_validity_check" CHECK ("default_validity_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint

-- fiscal_year is '' when the number format has no FY token.
CREATE TABLE IF NOT EXISTS "quote_number_sequences" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "fiscal_year" text NOT NULL,
  "last_value" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "fiscal_year")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quote_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  -- { theme, sections }, validated as a unit by quoteTemplateBodySchema.
  "body" jsonb NOT NULL,
  "archived_at" timestamptz,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- At most one live default template per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "quote_templates_one_default_uq"
  ON "quote_templates" ("tenant_id")
  WHERE "is_default" AND "archived_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "quote_number" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "parent_quote_id" uuid REFERENCES "quotes"("id"),
  "status" "quote_status" NOT NULL DEFAULT 'draft',
  "template_id" uuid REFERENCES "quote_templates"("id") ON DELETE SET NULL,
  "template_snapshot" jsonb NOT NULL,
  "content" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "seller_profile_id" uuid REFERENCES "invoice_seller_profiles"("id") ON DELETE SET NULL,
  "seller" jsonb NOT NULL,
  "buyer" jsonb NOT NULL,
  "consignee" jsonb,
  "quote_date" date NOT NULL,
  "valid_until" date NOT NULL,
  "currency" text NOT NULL DEFAULT 'INR',
  "overall_discount_type" text NOT NULL DEFAULT 'none',
  -- minor units when type = 'amount', basis points when 'percent'.
  "overall_discount_value" bigint NOT NULL DEFAULT 0,
  "subtotal_minor" bigint NOT NULL DEFAULT 0,
  "discount_minor" bigint NOT NULL DEFAULT 0,
  "tax_minor" bigint NOT NULL DEFAULT 0,
  "total_minor" bigint NOT NULL DEFAULT 0,
  "sent_at" timestamptz,
  "sent_by" text,
  "pdf_document_id" uuid,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "quotes_overall_discount_type_check" CHECK ("overall_discount_type" IN ('none', 'amount', 'percent')),
  CONSTRAINT "quotes_number_revision_uq" UNIQUE ("tenant_id", "quote_number", "revision")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_tenant_deal_idx"
  ON "quotes" ("tenant_id", "deal_id");
--> statement-breakpoint
-- pdf_document_id -> deal_documents is NO ACTION (checked at statement end), not
-- RESTRICT: deleting a deal cascades to both quotes and deal_documents, and an
-- immediate RESTRICT check could fail depending on cascade order. NO ACTION
-- still blocks deleting a referenced document on its own. Drop + re-add so a
-- replay also corrects a database that got the earlier RESTRICT version.
ALTER TABLE "quotes" DROP CONSTRAINT IF EXISTS "quotes_pdf_document_id_fkey";
--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pdf_document_id_fkey"
  FOREIGN KEY ("pdf_document_id") REFERENCES "deal_documents"("id") ON DELETE NO ACTION;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "quote_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "quote_id" uuid NOT NULL REFERENCES "quotes"("id") ON DELETE CASCADE,
  "sort_order" integer NOT NULL DEFAULT 0,
  "description" text NOT NULL,
  "hsn_sac" text,
  "unit" text,
  "quantity" numeric(14, 3) NOT NULL,
  "rate_minor" bigint NOT NULL,
  "discount_bps" integer NOT NULL DEFAULT 0,
  "tax_rate_bps" integer NOT NULL DEFAULT 0,
  "amount_minor" bigint NOT NULL,
  "allocated_discount_minor" bigint NOT NULL DEFAULT 0,
  "tax_minor" bigint NOT NULL DEFAULT 0,
  "offering_id" uuid REFERENCES "offerings"("id") ON DELETE SET NULL,
  "group_label" text,
  CONSTRAINT "quote_items_discount_bps_check" CHECK ("discount_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "quote_items_tax_rate_bps_check" CHECK ("tax_rate_bps" BETWEEN 0 AND 4000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_items_quote_idx"
  ON "quote_items" ("tenant_id", "quote_id", "sort_order");
--> statement-breakpoint

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_settings', 'quote_number_sequences', 'quote_templates', 'quotes', 'quote_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
