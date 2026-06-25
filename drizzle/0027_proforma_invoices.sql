-- 0027_proforma_invoices.sql
-- Proforma Invoice (PI) module: header + line items, tenant-scoped + RLS.

CREATE TABLE IF NOT EXISTS "proforma_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "pi_number" text NOT NULL,
  "pi_date" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "currency" text NOT NULL DEFAULT 'INR',
  "seller" jsonb NOT NULL,
  "buyer" jsonb NOT NULL,
  "consignee" jsonb,
  "payment_terms" text,
  "delivery_terms" text,
  "notes" text,
  "tax_rate" numeric(5,2) NOT NULL DEFAULT '0',
  "subtotal_minor" bigint NOT NULL DEFAULT 0,
  "tax_minor" bigint NOT NULL DEFAULT 0,
  "total_minor" bigint NOT NULL DEFAULT 0,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proforma_invoices_tenant_number_unique" ON "proforma_invoices" ("tenant_id", "pi_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoices_tenant_created_idx" ON "proforma_invoices" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proforma_invoice_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "invoice_id" uuid NOT NULL REFERENCES "proforma_invoices"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "hsn_sac" text,
  "unit" text NOT NULL DEFAULT 'No',
  "quantity" integer NOT NULL DEFAULT 1,
  "rate_minor" bigint NOT NULL DEFAULT 0,
  "amount_minor" bigint NOT NULL DEFAULT 0,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoice_items_invoice_idx" ON "proforma_invoice_items" ("invoice_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proforma_invoice_items_tenant_idx" ON "proforma_invoice_items" ("tenant_id");
--> statement-breakpoint
-- RLS: same tenant-scoping pattern as memberships/activity_logs (0003).
ALTER TABLE "proforma_invoices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proforma_invoices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proforma_invoice_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "proforma_invoice_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "proforma_invoices_tenant_select" ON "proforma_invoices"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoices_tenant_insert" ON "proforma_invoices"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoices_tenant_update" ON "proforma_invoices"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoices_tenant_delete" ON "proforma_invoices"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoice_items_tenant_select" ON "proforma_invoice_items"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoice_items_tenant_insert" ON "proforma_invoice_items"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoice_items_tenant_update" ON "proforma_invoice_items"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "proforma_invoice_items_tenant_delete" ON "proforma_invoice_items"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- Explicit grants for the RLS role (default privileges from 0004 also cover
-- new tables, but be explicit so this migration is self-contained).
GRANT SELECT, INSERT, UPDATE, DELETE ON "proforma_invoices" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "proforma_invoice_items" TO "app_user";
