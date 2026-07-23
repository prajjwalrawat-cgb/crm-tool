-- 0053_dedup_guardrails.sql
-- Phase 2 / Module 5 (Duplicate Detection Guardrails). pg_trgm + normalized-name
-- columns/indexes on companies & contacts, merge bookkeeping columns, and the
-- merge_audit table.

-- Trigram similarity for fuzzy name matching.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- companies: normalized_name + merge columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "normalized_name" text;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "merged_into_id" uuid;
--> statement-breakpoint
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "dedup_override" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "companies"
    ADD CONSTRAINT "companies_merged_into_fk"
    FOREIGN KEY ("merged_into_id") REFERENCES "companies"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_tenant_merged_idx"
  ON "companies" ("tenant_id", "merged_into_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_normalized_name_trgm_idx"
  ON "companies" USING gin ("normalized_name" gin_trgm_ops);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- contacts: normalized_name + merge columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "normalized_name" text;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "merged_into_id" uuid;
--> statement-breakpoint
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "dedup_override" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "contacts"
    ADD CONSTRAINT "contacts_merged_into_fk"
    FOREIGN KEY ("merged_into_id") REFERENCES "contacts"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_tenant_merged_idx"
  ON "contacts" ("tenant_id", "merged_into_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_normalized_name_trgm_idx"
  ON "contacts" USING gin ("normalized_name" gin_trgm_ops);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill normalized_name. Companies: lower/strip punctuation + legal suffix
-- words (mirrors normalizeCompanyName). Contacts: lower/strip punctuation of
-- first+last. Best-effort in SQL; the app recomputes precisely on next write.
-- ---------------------------------------------------------------------------
UPDATE "companies"
SET "normalized_name" = trim(regexp_replace(
  regexp_replace(
    regexp_replace(lower("name"), '[^a-z0-9\s]', ' ', 'g'),
    '\y(ltd|limited|pvt|private|llp|inc|incorporated|corp|corporation|co|company|plc|llc|gmbh|sarl|bv|ag)\y', ' ', 'g'),
  '\s+', ' ', 'g'))
WHERE "normalized_name" IS NULL;
--> statement-breakpoint
UPDATE "contacts"
SET "normalized_name" = trim(regexp_replace(
  regexp_replace(lower(coalesce("first_name",'') || ' ' || coalesce("last_name",'')), '[^a-z0-9\s]', ' ', 'g'),
  '\s+', ' ', 'g'))
WHERE "normalized_name" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- merge_audit: full loser snapshot for reversibility.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "merge_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "winner_id" uuid NOT NULL,
  "loser_id" uuid NOT NULL,
  "loser_snapshot" jsonb NOT NULL,
  "repointed_counts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "merged_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merge_audit_tenant_created_idx"
  ON "merge_audit" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merge_audit_tenant_winner_idx"
  ON "merge_audit" ("tenant_id", "winner_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS on merge_audit (same pattern as 0049–0052).
-- ---------------------------------------------------------------------------
ALTER TABLE "merge_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "merge_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "merge_audit_tenant_select" ON "merge_audit"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "merge_audit_tenant_insert" ON "merge_audit"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "merge_audit_tenant_update" ON "merge_audit"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "merge_audit_tenant_delete" ON "merge_audit"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "merge_audit" TO "app_user";
