-- 0034_deal_contact_email.sql
-- Free-text contact email on the deal form (like company_name / contact_name).
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "contact_email" text;
