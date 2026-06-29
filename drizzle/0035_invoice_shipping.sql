-- 0035_invoice_shipping.sql
-- Shipping / freight charge on a PI, with its own GST rate.
ALTER TABLE "proforma_invoices" ADD COLUMN IF NOT EXISTS "shipping_minor" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "proforma_invoices" ADD COLUMN IF NOT EXISTS "shipping_tax_rate" numeric(5, 2) NOT NULL DEFAULT '0';
