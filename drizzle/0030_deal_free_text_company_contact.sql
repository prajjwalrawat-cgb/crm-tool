-- 0030_deal_free_text_company_contact.sql
-- Free-text company / contact labels on a deal (typed by the user, not
-- linked to a company/contact record). Shown via COALESCE with the FK name.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "company_name" text;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "contact_name" text;
