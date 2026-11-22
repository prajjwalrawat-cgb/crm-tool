-- 0079_prospect_board.sql
--
-- Prospect Board: a pre-lead staging area (stage 1). See
-- docs/superpowers/specs/2026-11-22-prospect-board-design.md.
--
--   prospect_imports        one row per Quick Dump / CSV / image import
--   prospects               the pre-lead records, with a kanban stage
--   prospect_stage_history  every stage change (avg days in stage)
--   prospect_votes          'know_someone' / 'priority' toggles
--
-- All four are tenant tables with ENABLE + FORCE RLS and the four standard
-- tenant policies (same pattern as 0077), granted to app_user, nothing to
-- anon / authenticated. Soft-deleted prospects stay visible to the policy on
-- purpose: callers filter deleted_at themselves.
--
-- Also: deals.source_prospect_id, five organization_settings columns, and the
-- ai_suggestions / ai_suggestion_sources / lead_sources CHECKs widened.
--
-- Idempotent: safe to replay on every deploy.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "prospect_stage" AS ENUM ('dump', 'researching', 'qualified', 'ready', 'parked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prospect_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_tag" text NOT NULL,
  "input_kind" text NOT NULL,
  "raw_text" text,
  "raw_file_path" text,
  "parser_model" text,
  "parser_output" jsonb,
  "status" text NOT NULL DEFAULT 'parsed',
  "rows_parsed" integer NOT NULL DEFAULT 0,
  "rows_inserted" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "confirmed_at" timestamptz,
  CONSTRAINT "prospect_imports_input_kind_check" CHECK ("input_kind" IN ('text', 'csv', 'image')),
  CONSTRAINT "prospect_imports_status_check" CHECK ("status" IN ('parsed', 'confirmed', 'discarded', 'failed'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prospects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "company_name" text NOT NULL,
  "normalized_name" text,
  "domain" text,
  "contact_name" text,
  "contact_designation" text,
  "contact_email" text,
  "contact_phone" text,
  "email_normalized" text,
  "phone_normalized" text,
  "industry" text,
  "size_band" text,
  "city" text,
  "state" text,
  "product_fit_offering_id" uuid REFERENCES "offerings"("id") ON DELETE SET NULL,
  "icp_score" smallint,
  "cluster_tags" text[] NOT NULL DEFAULT '{}',
  "source_tag" text NOT NULL,
  "import_id" uuid REFERENCES "prospect_imports"("id") ON DELETE SET NULL,
  "notes" text,
  "stage" "prospect_stage" NOT NULL DEFAULT 'dump',
  "stage_changed_at" timestamptz NOT NULL DEFAULT now(),
  "parked_reason" text,
  "claimed_by" text,
  "claimed_at" timestamptz,
  "claim_expires_at" timestamptz,
  "promoted_deal_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL,
  "promoted_at" timestamptz,
  "promoted_by" text,
  "last_activity_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "prospects_size_band_check" CHECK ("size_band" IS NULL OR "size_band" IN ('1-10', '11-50', '51-200', '201-1000', '1000+')),
  CONSTRAINT "prospects_icp_score_check" CHECK ("icp_score" IS NULL OR ("icp_score" >= 0 AND "icp_score" <= 100)),
  CONSTRAINT "prospects_parked_reason_check" CHECK ("parked_reason" IS NULL OR "parked_reason" IN ('stale', 'manual'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_tenant_stage_idx"
  ON "prospects" ("tenant_id", "stage") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_tenant_claimed_by_idx"
  ON "prospects" ("tenant_id", "claimed_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_tenant_source_tag_idx"
  ON "prospects" ("tenant_id", "source_tag");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_tenant_last_activity_idx"
  ON "prospects" ("tenant_id", "last_activity_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_tenant_created_idx"
  ON "prospects" ("tenant_id", "created_at") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospects_normalized_name_trgm_idx"
  ON "prospects" USING gin ("normalized_name" gin_trgm_ops);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prospects_tenant_promoted_deal_unique"
  ON "prospects" ("tenant_id", "promoted_deal_id") WHERE "promoted_deal_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prospect_stage_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "prospect_id" uuid NOT NULL REFERENCES "prospects"("id") ON DELETE CASCADE,
  "from_stage" "prospect_stage",
  "to_stage" "prospect_stage" NOT NULL,
  -- user id, or 'system:auto-park'
  "changed_by" text NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospect_stage_history_prospect_idx"
  ON "prospect_stage_history" ("tenant_id", "prospect_id", "changed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospect_stage_history_autopark_idx"
  ON "prospect_stage_history" ("tenant_id", "changed_at") WHERE "changed_by" = 'system:auto-park';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "prospect_votes" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "prospect_id" uuid NOT NULL REFERENCES "prospects"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("prospect_id", "user_id", "kind"),
  CONSTRAINT "prospect_votes_kind_check" CHECK ("kind" IN ('know_someone', 'priority'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prospect_votes_tenant_idx"
  ON "prospect_votes" ("tenant_id", "prospect_id");
--> statement-breakpoint

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['prospect_imports', 'prospects', 'prospect_stage_history', 'prospect_votes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_delete', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_tenant_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

-- deals -> prospects (the prospect side is prospects.promoted_deal_id).
ALTER TABLE "deals"
  ADD COLUMN IF NOT EXISTS "source_prospect_id" uuid REFERENCES "prospects"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_source_prospect_idx"
  ON "deals" ("source_prospect_id") WHERE "source_prospect_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "prospect_claim_days" integer NOT NULL DEFAULT 14,
  ADD COLUMN IF NOT EXISTS "prospect_claim_expiry_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "prospect_auto_park_days" integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS "prospect_auto_park_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "prospect_enrichment_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Widen the AI-suggestion / lead-source CHECKs (existing values + prospect / enrichment).
-- REPLAY TRAP: every build replays all migrations. A plain DROP + ADD here would
-- re-add this (narrower) list after a later migration widened it, and the
-- validation scan would fail on rows holding the newer values. So each block only
-- rewrites the constraint when it is missing or lacks this migration's marker
-- value. A later migration that widens one of these must keep the same guard.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_suggestions_entity_type_check' AND conrelid = '"ai_suggestions"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''prospect''%'
  ) THEN
    ALTER TABLE "ai_suggestions" DROP CONSTRAINT IF EXISTS "ai_suggestions_entity_type_check";
    ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_entity_type_check" CHECK ("entity_type" IN ('deal', 'contact', 'lead', 'prospect'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_suggestions_field_check' AND conrelid = '"ai_suggestions"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''icp_score''%'
  ) THEN
    ALTER TABLE "ai_suggestions" DROP CONSTRAINT IF EXISTS "ai_suggestions_field_check";
    ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_field_check" CHECK ("field" IN (
      'stage', 'amount', 'close_date', 'next_step',
      'contact_name', 'contact_email', 'contact_phone', 'contact_designation',
      'follow_up_task',
      'industry', 'size_band', 'product_fit', 'icp_score'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_suggestions_source_type_check' AND conrelid = '"ai_suggestions"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''enrichment''%'
  ) THEN
    ALTER TABLE "ai_suggestions" DROP CONSTRAINT IF EXISTS "ai_suggestions_source_type_check";
    ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_source_type_check" CHECK ("source_type" IN ('call', 'email', 'enrichment'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_suggestion_sources_type_check' AND conrelid = '"ai_suggestion_sources"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''enrichment''%'
  ) THEN
    ALTER TABLE "ai_suggestion_sources" DROP CONSTRAINT IF EXISTS "ai_suggestion_sources_type_check";
    ALTER TABLE "ai_suggestion_sources" ADD CONSTRAINT "ai_suggestion_sources_type_check" CHECK ("source_type" IN ('call', 'email', 'enrichment'));
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lead_sources_type_check' AND conrelid = '"lead_sources"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''prospect_board''%'
  ) THEN
    ALTER TABLE "lead_sources" DROP CONSTRAINT IF EXISTS "lead_sources_type_check";
    ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_type_check" CHECK ("type" IN
      ('web_form', 'landing_page', 'webhook', 'csv_import', 'api', 'manual', 'meta_ads', 'google_ads', 'portal', 'prospect_board'));
  END IF;
END $$;

