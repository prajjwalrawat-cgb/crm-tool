-- 0031_invoice_settings.sql
-- Per-workspace invoice seller + bank details (auto-filled on new invoices).
-- Stored on the existing per-tenant organization_settings row.
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_seller_name" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_seller_address" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_gstin" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_pan" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_cin" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_bank_name" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_bank_account" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_bank_ifsc" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_bank_branch" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_payment_terms" text;
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_delivery_terms" text;
