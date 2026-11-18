-- 0077_ai_suggestions.sql
--
-- AI-proposed changes to deals and contacts, with a human accept/reject
-- queue. AI never writes deal or contact fields: a suggestion is applied only
-- when a user accepts it, through the same server actions (and stage gates,
-- RBAC) as a manual edit. See src/lib/ai/suggestions/.
--
--   ai_suggestions         one proposed field change (or follow-up task)
--   ai_suggestion_sources  one row per processed call / email thread, the
--                          idempotency claim for the extractor
--
-- Both are tenant tables with ENABLE + FORCE RLS and the four standard tenant
-- policies (same pattern as 0062 / 0075), granted to app_user, nothing to
-- anon / authenticated. Plus organization_settings.ai_suggestions_enabled
-- (default OFF).
--
-- Idempotent: safe to replay on every deploy.

CREATE TABLE IF NOT EXISTS "ai_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "field" text NOT NULL,
  "current_value_at_suggestion" jsonb,
  "suggested_value" jsonb NOT NULL,
  "evidence_quote" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "confidence" real NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "model" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Set while a user's accept is being applied (claim), and on decision.
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_note" text,
  -- What was actually written (differs from suggested_value on edit-and-accept).
  "applied_value" jsonb,
  -- The live value seen when a decision found the field had changed (stale).
  "live_value_at_decision" jsonb,
  CONSTRAINT "ai_suggestions_entity_type_check" CHECK ("entity_type" IN ('deal', 'contact', 'lead')),
  CONSTRAINT "ai_suggestions_field_check" CHECK ("field" IN (
    'stage', 'amount', 'close_date', 'next_step',
    'contact_name', 'contact_email', 'contact_phone', 'contact_designation',
    'follow_up_task')),
  CONSTRAINT "ai_suggestions_source_type_check" CHECK ("source_type" IN ('call', 'email')),
  CONSTRAINT "ai_suggestions_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected', 'superseded', 'stale')),
  CONSTRAINT "ai_suggestions_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "ai_suggestions_evidence_len" CHECK (char_length("evidence_quote") <= 500)
);
--> statement-breakpoint
-- The extractor writes each (source, entity, field) once.
CREATE UNIQUE INDEX IF NOT EXISTS "ai_suggestions_source_field_unique"
  ON "ai_suggestions" ("tenant_id", "source_type", "source_id", "entity_type", "entity_id", "field");
--> statement-breakpoint
-- Queue, badge and deal card: pending items per entity.
CREATE INDEX IF NOT EXISTS "ai_suggestions_pending_entity_idx"
  ON "ai_suggestions" ("tenant_id", "entity_type", "entity_id")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestions_tenant_created_idx"
  ON "ai_suggestions" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ai_suggestion_sources" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  -- running | done | failed | skipped
  "status" text NOT NULL DEFAULT 'running',
  "model" text,
  "suggestions_count" integer NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "source_type", "source_id"),
  CONSTRAINT "ai_suggestion_sources_type_check" CHECK ("source_type" IN ('call', 'email')),
  CONSTRAINT "ai_suggestion_sources_status_check" CHECK ("status" IN ('running', 'done', 'failed', 'skipped'))
);
--> statement-breakpoint

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_suggestions', 'ai_suggestion_sources'] LOOP
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

ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "ai_suggestions_enabled" boolean NOT NULL DEFAULT false;
