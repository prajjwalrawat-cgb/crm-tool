-- 0029_invoice_edited_by.sql
-- Audit: who last edited a proforma invoice.
ALTER TABLE "proforma_invoices" ADD COLUMN IF NOT EXISTS "edited_by" text;
