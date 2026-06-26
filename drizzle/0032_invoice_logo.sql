-- 0032_invoice_logo.sql
-- Per-workspace invoice logo (shown top-left on the PDF, like the reference).
ALTER TABLE "organization_settings" ADD COLUMN IF NOT EXISTS "invoice_logo_url" text;
