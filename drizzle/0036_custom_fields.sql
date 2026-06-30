-- 0036_custom_fields.sql
-- Admin-defined custom fields. Definitions live in their own table; values are
-- stored in a jsonb column on the entity row (keyed by definition `key`).
CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "field_type" text NOT NULL,
  "options" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "required" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cfd_tenant_entity_key_uniq"
  ON "custom_field_definitions" ("tenant_id", "entity_type", "key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cfd_tenant_entity_idx"
  ON "custom_field_definitions" ("tenant_id", "entity_type");
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "custom_fields" jsonb NOT NULL DEFAULT '{}'::jsonb;
