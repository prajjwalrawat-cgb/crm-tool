-- 0039_custom_fields_company_contact.sql
-- Extend custom field values to companies and contacts (definitions already
-- support every entity type via custom_field_definitions.entity_type).
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb;
