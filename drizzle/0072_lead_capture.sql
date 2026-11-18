-- 0072 — Lead capture & rule-based distribution (build prompt 1, slice 1).
--
-- SHAPE
-- A lead stays what it already is in this CRM: a `deals` row at stage 'lead',
-- linked to a `contacts` row. Capture adds:
--   * lead_sources         — where leads come from (webhook, form, CSV, portal …);
--                            each carries its own secret for token/HMAC auth.
--   * capture_forms        — hosted/embeddable forms (UI lands in a later slice).
--   * lead_ingest_events   — every inbound payload, stored BEFORE processing, so
--                            a mapping failure never loses a lead.
--   * distribution_rules   — ordered rules (lower priority first, first match wins).
--   * distribution_state   — the round-robin / weighted pointer per rule, locked
--                            with SELECT … FOR UPDATE so concurrent leads never
--                            double-pick.
--   * user_routing_profile — availability, working hours, skills, regions.
--                            Keyed (tenant_id, user_id): a user can belong to
--                            several workspaces.
--   * lead_assignments     — assignment audit trail; drives SLA + reassignment.
--   * rate_limit_hits      — fixed-window counters for the public endpoints
--                            (serverless has no shared memory).
--
-- User ids are `text` everywhere, matching users.id.

ALTER TABLE "deals"
  ADD COLUMN IF NOT EXISTS "lead_source_id" uuid,
  ADD COLUMN IF NOT EXISTS "utm_source" text,
  ADD COLUMN IF NOT EXISTS "utm_medium" text,
  ADD COLUMN IF NOT EXISTS "utm_campaign" text,
  ADD COLUMN IF NOT EXISTS "utm_term" text,
  ADD COLUMN IF NOT EXISTS "utm_content" text,
  ADD COLUMN IF NOT EXISTS "landing_url" text,
  ADD COLUMN IF NOT EXISTS "referrer_url" text,
  ADD COLUMN IF NOT EXISTS "consent_given" boolean,
  ADD COLUMN IF NOT EXISTS "consent_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "last_enquiry_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "lead_city" text,
  ADD COLUMN IF NOT EXISTS "lead_state" text,
  ADD COLUMN IF NOT EXISTS "lead_product_interest" text,
  -- NULL = not a routed lead (created by hand). 'pending' = waiting for the
  -- distributor, 'unassigned' = no eligible rep (manager queue), 'assigned'.
  ADD COLUMN IF NOT EXISTS "routing_status" text,
  ADD COLUMN IF NOT EXISTS "routing_queued_at" timestamptz;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "deals" ADD CONSTRAINT "deals_routing_status_check"
    CHECK ("routing_status" IS NULL OR "routing_status" IN ('pending', 'unassigned', 'assigned'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_tenant_routing_idx"
  ON "deals" ("tenant_id", "routing_status", "routing_queued_at")
  WHERE "routing_status" IN ('pending', 'unassigned');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_tenant_lead_source_idx"
  ON "deals" ("tenant_id", "lead_source_id");
--> statement-breakpoint

ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "phone_normalized" text,
  ADD COLUMN IF NOT EXISTS "email_normalized" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_tenant_phone_norm_idx"
  ON "contacts" ("tenant_id", "phone_normalized") WHERE "phone_normalized" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_tenant_email_norm_idx"
  ON "contacts" ("tenant_id", "email_normalized") WHERE "email_normalized" IS NOT NULL;
--> statement-breakpoint
-- Email can be normalized in SQL. Phones need libphonenumber: see
-- scripts/backfill-contact-phones.ts.
UPDATE "contacts" SET "email_normalized" = lower(btrim("email"))
  WHERE "email" IS NOT NULL AND btrim("email") <> '' AND "email_normalized" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "secret_token" text NOT NULL,
  "field_mapping" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "default_rule_id" uuid,
  "allowed_origins" text[] NOT NULL DEFAULT '{}',
  -- Per-type settings, e.g. Meta: {"page_id","form_ids":[],"page_token"}.
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "lead_sources_type_check" CHECK ("type" IN
    ('web_form', 'landing_page', 'webhook', 'csv_import', 'api', 'manual', 'meta_ads', 'google_ads', 'portal'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_sources_tenant_idx" ON "lead_sources" ("tenant_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "capture_forms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "lead_sources"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "fields" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "thank_you_message" text,
  "redirect_url" text,
  "consent_text" text,
  "theme" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_published" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "capture_forms_tenant_slug_unique" UNIQUE ("tenant_id", "slug")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_ingest_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "lead_sources"("id") ON DELETE CASCADE,
  "raw_payload" jsonb NOT NULL,
  -- sha256(source_id + canonical payload). A replay inside 24h returns the
  -- original event instead of creating a second one.
  "idempotency_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'received',
  "error" text,
  "deal_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "lead_ingest_events_status_check" CHECK ("status" IN ('received', 'processed', 'duplicate', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_ingest_events_tenant_status_idx"
  ON "lead_ingest_events" ("tenant_id", "status", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_ingest_events_idem_idx"
  ON "lead_ingest_events" ("source_id", "idempotency_key", "received_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_ingest_events_source_idx"
  ON "lead_ingest_events" ("tenant_id", "source_id", "received_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "distribution_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "priority" integer NOT NULL,
  "conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "strategy" text NOT NULL,
  "pool" jsonb NOT NULL DEFAULT '{"user_ids":[]}'::jsonb,
  "capacity_cap" integer,
  "respect_availability" boolean NOT NULL DEFAULT true,
  "sla_minutes" integer NOT NULL DEFAULT 30,
  "max_reassignments" integer NOT NULL DEFAULT 2,
  -- The tenant fallback rule, used when no other rule matches. At most one.
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "distribution_rules_strategy_check" CHECK ("strategy" IN
    ('round_robin', 'weighted', 'least_loaded', 'skill_match', 'geo_match', 'fixed_owner')),
  CONSTRAINT "distribution_rules_sla_check" CHECK ("sla_minutes" > 0),
  CONSTRAINT "distribution_rules_reassign_check" CHECK ("max_reassignments" >= 0),
  CONSTRAINT "distribution_rules_capacity_check" CHECK ("capacity_cap" IS NULL OR "capacity_cap" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distribution_rules_tenant_priority_idx"
  ON "distribution_rules" ("tenant_id", "is_active", "priority");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "distribution_rules_one_default"
  ON "distribution_rules" ("tenant_id") WHERE "is_default";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "distribution_state" (
  "rule_id" uuid PRIMARY KEY REFERENCES "distribution_rules"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "last_user_id" text,
  -- Smooth weighted round-robin "current weight" per user id.
  "weights_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_routing_profile" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "is_available" boolean NOT NULL DEFAULT true,
  -- {"tz":"Asia/Kolkata","days":{"mon":["09:30","18:30"],…}}; NULL = always on.
  "working_hours" jsonb,
  "skills" text[] NOT NULL DEFAULT '{}',
  "regions" text[] NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "user_id")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "assigned_to" text NOT NULL,
  -- 'rule:<id>' | 'user:<id>' | 'system:sla' | 'system:retry'
  "assigned_by" text NOT NULL,
  "rule_id" uuid REFERENCES "distribution_rules"("id") ON DELETE SET NULL,
  "reason" text,
  "assigned_at" timestamptz NOT NULL DEFAULT now(),
  "first_touch_at" timestamptz,
  "sla_due_at" timestamptz NOT NULL,
  "released_at" timestamptz,
  -- 'sla_breach' | 'manual_reassign'
  "release_reason" text,
  "escalated_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_assignments_deal_idx"
  ON "lead_assignments" ("tenant_id", "deal_id", "assigned_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_assignments_sla_idx"
  ON "lead_assignments" ("tenant_id", "sla_due_at")
  WHERE "first_touch_at" IS NULL AND "released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_assignments_user_open_idx"
  ON "lead_assignments" ("tenant_id", "assigned_to", "assigned_at")
  WHERE "released_at" IS NULL;
--> statement-breakpoint
-- A lead has at most one open assignment, ever. This is the database backstop
-- against a double assignment under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS "lead_assignments_one_open"
  ON "lead_assignments" ("deal_id") WHERE "released_at" IS NULL;
--> statement-breakpoint

-- CSV imports: the parsed rows live on the job until it finishes, so a
-- crashed worker resumes from `processed` without re-uploading.
CREATE TABLE IF NOT EXISTS "lead_import_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "lead_sources"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL,
  "file_name" text,
  "mapping" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "rows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "total" integer NOT NULL DEFAULT 0,
  "processed" integer NOT NULL DEFAULT 0,
  "created_count" integer NOT NULL DEFAULT 0,
  "duplicate_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "lead_import_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_import_jobs_tenant_idx" ON "lead_import_jobs" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "capture_forms_source_idx" ON "capture_forms" ("source_id");
--> statement-breakpoint

-- RLS: same tenant predicate as 0071 on every tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_sources', 'capture_forms', 'lead_ingest_events',
    'distribution_rules', 'distribution_state', 'user_routing_profile', 'lead_assignments',
    'lead_import_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      'USING (tenant_id = (select nullif(current_setting(''app.tenant_id'', true), '''')::uuid)) '
      'WITH CHECK (tenant_id = (select nullif(current_setting(''app.tenant_id'', true), '''')::uuid))',
      t || '_tenant_all', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- Public endpoints resolve the tenant from the source id BEFORE any tenant
-- context exists. This is the only cross-tenant read they get: one row, by id,
-- only the fields needed to authenticate the request.
CREATE OR REPLACE FUNCTION "lead_source_public_lookup"(p_source_id uuid)
RETURNS TABLE (tenant_id uuid, secret_token text, is_active boolean, allowed_origins text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, s.secret_token, s.is_active, s.allowed_origins
  FROM lead_sources s WHERE s.id = p_source_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "lead_source_public_lookup"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "lead_source_public_lookup"(uuid) TO app_user;
--> statement-breakpoint

-- Hosted forms: resolve /f/<tenant-slug>/<form-slug> before tenant context.
-- Only PUBLISHED forms of ACTIVE sources are visible.
CREATE OR REPLACE FUNCTION "capture_form_public_lookup"(p_tenant_slug text, p_form_slug text)
RETURNS TABLE (tenant_id uuid, form_id uuid, source_id uuid, title text, fields jsonb,
  thank_you_message text, redirect_url text, consent_text text, theme jsonb, allowed_origins text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.tenant_id, f.id, f.source_id, f.title, f.fields, f.thank_you_message, f.redirect_url,
         f.consent_text, f.theme, s.allowed_origins
  FROM capture_forms f
  JOIN tenants t ON t.id = f.tenant_id
  JOIN lead_sources s ON s.id = f.source_id
  WHERE t.slug = p_tenant_slug AND f.slug = p_form_slug AND f.is_published AND s.is_active;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "capture_form_public_lookup"(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "capture_form_public_lookup"(text, text) TO app_user;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rate_limit_hits" (
  "bucket" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "hits" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("bucket", "window_start")
);
--> statement-breakpoint
ALTER TABLE "rate_limit_hits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON "rate_limit_hits" FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON "rate_limit_hits" FROM authenticated; END IF;
END $$;
--> statement-breakpoint
-- Count one hit against `p_bucket` in the current fixed window. Returns true
-- while the bucket is within `p_limit`. One atomic upsert per call.
CREATE OR REPLACE FUNCTION "rate_limit_hit"(p_bucket text, p_window_seconds integer, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_window timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
BEGIN
  INSERT INTO rate_limit_hits (bucket, window_start, hits) VALUES (p_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_hits.hits + 1
  RETURNING hits INTO v_hits;
  RETURN v_hits <= p_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "rate_limit_hit"(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "rate_limit_hit"(text, integer, integer) TO app_user;
