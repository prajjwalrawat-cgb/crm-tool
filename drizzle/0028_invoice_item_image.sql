-- 0028_invoice_item_image.sql
-- Per-line-item product image (Supabase Storage public URL).
ALTER TABLE "proforma_invoice_items" ADD COLUMN IF NOT EXISTS "image_url" text;
