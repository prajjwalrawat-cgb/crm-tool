-- 0081_field_meetings.sql
--
-- Field Meetings (PR 1 foundation, all of M1). See
-- docs/superpowers/specs/2026-11-25-field-meetings-design.md.
--
--   meetings / meeting_checkins / meeting_outcomes   the meeting lifecycle
--   calendar_connections                             per-user Google / Outlook link (used from PR 2)
--   location_pings                                   native tracker pings, PARTITIONED BY DAY
--   location_view_audit                              who looked at whose location
--   tenant_field_settings                            one row per tenant (missing row = defaults)
--   geocode_cache / drive_time_cache                 provider response caches
--
-- Also: address + geocode columns on companies, and askmira_employee_id /
-- match_method on askmira_people (the identity link; no parallel table).
--
-- All nine new tables are tenant tables with ENABLE + FORCE RLS and the four
-- standard tenant policies (same pattern as 0079), granted to app_user.
-- location_pings is partitioned: RLS and the grant sit on the parent, and the
-- daily partitions for today..+7 (UTC) are created here. PR 3 adds the job that
-- creates future partitions and drops ones older than 90 days.
--
-- Idempotent: safe to replay on every deploy.

DO $$ BEGIN
  CREATE TYPE "meeting_type" AS ENUM ('physical', 'virtual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "meeting_status" AS ENUM ('planned', 'en_route', 'arrived', 'checked_in', 'checked_out', 'mom_logged', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "meeting_source" AS ENUM ('manual', 'gcal', 'outlook', 'walk_in');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "geocode_status" AS ENUM ('pending', 'ok', 'failed', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "checkin_kind" AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "location_source" AS ENUM ('askmira', 'native', 'browser');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "meeting_sentiment" AS ENUM ('positive', 'neutral', 'negative');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "calendar_provider" AS ENUM ('google', 'microsoft');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "location_provider" AS ENUM ('askmira', 'native', 'none');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "identity_match_method" AS ENUM ('sso', 'email', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Company address (meeting address defaults to this).
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "address" text,
  ADD COLUMN IF NOT EXISTS "city" text,
  ADD COLUMN IF NOT EXISTS "state" text,
  ADD COLUMN IF NOT EXISTS "postal_code" text,
  ADD COLUMN IF NOT EXISTS "lat" double precision,
  ADD COLUMN IF NOT EXISTS "lng" double precision,
  ADD COLUMN IF NOT EXISTS "geocode_status" "geocode_status";
--> statement-breakpoint

-- Optional per-company check-in radius (metres). When set it overrides the
-- tenant default (tenant_field_settings.checkin_radius_m), e.g. for large
-- industrial sites. The inline CHECK is only added with the column, so replays
-- are no-ops.
ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "checkin_radius_m" integer
  CONSTRAINT "companies_checkin_radius_m_check" CHECK ("checkin_radius_m" IS NULL OR "checkin_radius_m" BETWEEN 50 AND 5000);
--> statement-breakpoint

-- AskMira identity link (replaces the spec's user_identity_links).
ALTER TABLE "askmira_people"
  ADD COLUMN IF NOT EXISTS "askmira_employee_id" text,
  ADD COLUMN IF NOT EXISTS "match_method" "identity_match_method";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "meetings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL,
  "company_id" uuid REFERENCES "companies"("id") ON DELETE SET NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "owner_id" text NOT NULL REFERENCES "users"("id"),
  "title" text NOT NULL,
  "type" "meeting_type" NOT NULL DEFAULT 'physical',
  "start_at" timestamptz NOT NULL,
  "end_at" timestamptz NOT NULL,
  "address" text,
  "lat" double precision,
  "lng" double precision,
  "geocode_status" "geocode_status" NOT NULL DEFAULT 'pending',
  "virtual_url" text,
  "status" "meeting_status" NOT NULL DEFAULT 'planned',
  "source" "meeting_source" NOT NULL DEFAULT 'manual',
  "external_calendar_id" text,
  "external_event_id" text,
  "external_etag" text,
  "sync_state" text,
  "needs_linking" boolean NOT NULL DEFAULT false,
  "at_risk_reasons" text[] NOT NULL DEFAULT '{}',
  "notes" text,
  "checked_in_at" timestamptz,
  "checked_out_at" timestamptz,
  "cancelled_at" timestamptz,
  "cancel_reason" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "meetings_end_after_start_check" CHECK ("end_at" > "start_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meetings_tenant_source_external_unique"
  ON "meetings" ("tenant_id", "source", "external_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_tenant_owner_start_idx"
  ON "meetings" ("tenant_id", "owner_id", "start_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_tenant_start_idx"
  ON "meetings" ("tenant_id", "start_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meetings_tenant_deal_idx"
  ON "meetings" ("tenant_id", "deal_id");
--> statement-breakpoint

-- Every check-in / check-out attempt is logged, accepted or not.
CREATE TABLE IF NOT EXISTS "meeting_checkins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "meeting_id" uuid NOT NULL REFERENCES "meetings"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "kind" "checkin_kind" NOT NULL,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy_m" double precision,
  -- null when the site has no coordinates
  "distance_from_site_m" double precision,
  "verified" boolean NOT NULL DEFAULT false,
  "accepted" boolean NOT NULL DEFAULT true,
  "override_reason" text,
  "reject_reason" text,
  "location_source" "location_source" NOT NULL DEFAULT 'browser',
  "captured_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_checkins_tenant_meeting_captured_idx"
  ON "meeting_checkins" ("tenant_id", "meeting_id", "captured_at");
--> statement-breakpoint

-- One outcome (MOM) per meeting; editing replaces it.
CREATE TABLE IF NOT EXISTS "meeting_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "meeting_id" uuid NOT NULL UNIQUE REFERENCES "meetings"("id") ON DELETE CASCADE,
  "mom_text" text,
  "audio_url" text,
  "transcript" text,
  "summary" text,
  "next_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "sentiment" "meeting_sentiment",
  "deal_stage_suggestion" text,
  "competitor_mentions" text[] NOT NULL DEFAULT '{}',
  -- none | pending | done | needs_review (filled from PR 3)
  "ai_status" text NOT NULL DEFAULT 'none',
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "calendar_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" "calendar_provider" NOT NULL,
  "account_email" text,
  "refresh_token_enc" text,
  "access_token_enc" text,
  "access_token_expires_at" timestamptz,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "sync_token" text,
  "delta_link" text,
  "channel_id" text,
  "channel_resource_id" text,
  "channel_expiry" timestamptz,
  "last_synced_at" timestamptz,
  "status" text NOT NULL DEFAULT 'active',
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_connections_tenant_user_provider_unique"
  ON "calendar_connections" ("tenant_id", "user_id", "provider");
--> statement-breakpoint

-- Native provider only. The Drizzle model treats this as a normal table.
CREATE TABLE IF NOT EXISTS "location_pings" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "lat" double precision NOT NULL,
  "lng" double precision NOT NULL,
  "accuracy_m" double precision,
  "battery_pct" smallint,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "captured_at")
) PARTITION BY RANGE ("captured_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "location_pings_tenant_user_captured_idx"
  ON "location_pings" ("tenant_id", "user_id", "captured_at");
--> statement-breakpoint
-- Daily partitions location_pings_YYYYMMDD for today..today+7 (UTC).
--
-- CONTRACT for anything that creates a partition later (PR 3's partition job):
--   * bounds are one UTC day: [d 00:00 UTC, d+1 00:00 UTC)
--   * name is location_pings_YYYYMMDD
--   * after CREATE, run ENABLE + FORCE ROW LEVEL SECURITY on the partition and
--     REVOKE ALL on it from app_user (and anon / authenticated if they exist).
-- Why: the default privileges from 0004 grant app_user full DML on every new
-- table, and RLS is not inherited by partitions, so a bare partition would let
-- a query that names it directly read every tenant's pings. With RLS on and no
-- policies, direct access is denied; access through the parent still uses the
-- parent's policies and privileges.
DO $$
DECLARE
  d date;
  part text;
  r text;
BEGIN
  FOR d IN SELECT g::date FROM generate_series(
    (now() AT TIME ZONE 'UTC')::date,
    (now() AT TIME ZONE 'UTC')::date + 7,
    interval '1 day') AS g
  LOOP
    part := 'location_pings_' || to_char(d, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF location_pings FOR VALUES FROM (%L) TO (%L)',
      part,
      (d::timestamp AT TIME ZONE 'UTC'),
      ((d + 1)::timestamp AT TIME ZONE 'UTC'));
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
    EXECUTE format('REVOKE ALL ON %I FROM app_user', part);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', part, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "location_view_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "viewer_id" text NOT NULL,
  "subject_user_id" text NOT NULL,
  "viewed_at" timestamptz NOT NULL DEFAULT now(),
  "context" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "location_view_audit_tenant_viewed_idx"
  ON "location_view_audit" ("tenant_id", "viewed_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_field_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "location_provider" "location_provider" NOT NULL DEFAULT 'none',
  "checkin_radius_m" integer NOT NULL DEFAULT 300,
  "no_checkin_grace_min" integer NOT NULL DEFAULT 15,
  "mom_due_hours" integer NOT NULL DEFAULT 2,
  "tracking_start" time NOT NULL DEFAULT '09:00',
  "tracking_end" time NOT NULL DEFAULT '19:00',
  "tracking_interval_sec" integer NOT NULL DEFAULT 120,
  "checkin_opens_before_min" integer NOT NULL DEFAULT 120,
  "checkin_closes_after_min" integer NOT NULL DEFAULT 240,
  "askmira_base_url" text,
  "askmira_service_token_enc" text,
  "askmira_webhook_secret_enc" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "geocode_cache" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "normalized_address" text NOT NULL,
  "lat" double precision,
  "lng" double precision,
  "status" "geocode_status" NOT NULL,
  "provider" text NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "normalized_address")
);
--> statement-breakpoint

-- Keys are lat/lng rounded to 4 dp; depart_bucket is departure rounded to 30 min.
-- Rows older than 30 min are ignored by readers.
CREATE TABLE IF NOT EXISTS "drive_time_cache" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "origin_key" text NOT NULL,
  "dest_key" text NOT NULL,
  "depart_bucket" timestamptz NOT NULL,
  "minutes" double precision NOT NULL,
  "provider" text NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "origin_key", "dest_key", "depart_bucket")
);
--> statement-breakpoint

-- Same-tenant enforcement for meeting children: a child row's tenant_id must
-- equal its meeting's. The composite FK sits next to the plain meeting_id FK
-- (which stays, harmlessly). Every constraint below is added only when missing
-- by name, so a replay on a DB that already has 0081 applies them too.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_tenant_id_id_unique' AND conrelid = '"meetings"'::regclass) THEN
    ALTER TABLE "meetings" ADD CONSTRAINT "meetings_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_checkins_tenant_meeting_fk' AND conrelid = '"meeting_checkins"'::regclass) THEN
    ALTER TABLE "meeting_checkins" ADD CONSTRAINT "meeting_checkins_tenant_meeting_fk"
      FOREIGN KEY ("tenant_id", "meeting_id") REFERENCES "meetings" ("tenant_id", "id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_outcomes_tenant_meeting_fk' AND conrelid = '"meeting_outcomes"'::regclass) THEN
    ALTER TABLE "meeting_outcomes" ADD CONSTRAINT "meeting_outcomes_tenant_meeting_fk"
      FOREIGN KEY ("tenant_id", "meeting_id") REFERENCES "meetings" ("tenant_id", "id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint

-- Check-in time window (minutes before start / after end). Added after the
-- table first shipped to the test DB, so guarded for replays.
ALTER TABLE "tenant_field_settings"
  ADD COLUMN IF NOT EXISTS "checkin_opens_before_min" integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS "checkin_closes_after_min" integer NOT NULL DEFAULT 240;
--> statement-breakpoint

-- Where a meeting's site comes from, and whether a rep typed its address. Added
-- after the table first shipped to the test DB, so guarded for replays.
ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "site_source" text,
  ADD COLUMN IF NOT EXISTS "site_rep_entered" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_site_source_check' AND conrelid = '"meetings"'::regclass) THEN
    ALTER TABLE "meetings" ADD CONSTRAINT "meetings_site_source_check" CHECK ("site_source" IN ('company', 'address', 'pin', 'walk_in'));
  END IF;
END $$;
--> statement-breakpoint

-- Backfill physical meetings not classified yet (idempotent: only site_source IS NULL).
--   walk-in                                                        -> walk_in
--   inherited address (blank, company line, or street line) and not
--   the meeting's own pin (manual only when it equals the company's) -> company
--   any other manual point                                         -> pin
--   own address                                                    -> address (rep-entered when its creator cannot pin)
WITH cls AS (
  SELECT m.id,
    CASE
      WHEN m.source = 'walk_in' THEN 'walk_in'
      WHEN c.id IS NOT NULL
        AND (NULLIF(btrim(m.address), '') IS NULL
             OR btrim(m.address) = concat_ws(', ', NULLIF(btrim(c.address), ''), NULLIF(btrim(c.city), ''),
                                             NULLIF(btrim(c.state), ''), NULLIF(btrim(c.postal_code), ''))
             OR btrim(m.address) = btrim(c.address))
        AND (m.geocode_status <> 'manual'
             OR (c.geocode_status = 'manual' AND m.lat IS NOT DISTINCT FROM c.lat AND m.lng IS NOT DISTINCT FROM c.lng))
        THEN 'company'
      WHEN m.geocode_status = 'manual' THEN 'pin'
      WHEN NULLIF(btrim(m.address), '') IS NOT NULL THEN 'address'
    END AS src
  FROM "meetings" m
  LEFT JOIN "companies" c ON c.id = m.company_id AND c.tenant_id = m.tenant_id
  WHERE m.type = 'physical' AND m.site_source IS NULL
)
UPDATE "meetings" m
SET site_source = cls.src,
    site_rep_entered = (
      cls.src = 'address'
      AND EXISTS (
        SELECT 1 FROM "memberships" ms
        WHERE ms.tenant_id = m.tenant_id AND ms.user_id = m.created_by AND ms.role IN ('member', 'viewer')
      )
    )
FROM cls
WHERE cls.id = m.id AND cls.src IS NOT NULL;
--> statement-breakpoint

-- Sanity bounds on tenant_field_settings (guarded the same way).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_checkin_radius_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_checkin_radius_check" CHECK ("checkin_radius_m" BETWEEN 50 AND 5000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_grace_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_grace_check" CHECK ("no_checkin_grace_min" BETWEEN 0 AND 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_mom_due_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_mom_due_check" CHECK ("mom_due_hours" BETWEEN 1 AND 72);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_interval_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_interval_check" CHECK ("tracking_interval_sec" BETWEEN 30 AND 3600);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_tracking_window_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_tracking_window_check" CHECK ("tracking_start" < "tracking_end");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_checkin_opens_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_checkin_opens_check" CHECK ("checkin_opens_before_min" BETWEEN 0 AND 1440);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_field_settings_checkin_closes_check' AND conrelid = '"tenant_field_settings"'::regclass) THEN
    ALTER TABLE "tenant_field_settings" ADD CONSTRAINT "tenant_field_settings_checkin_closes_check" CHECK ("checkin_closes_after_min" BETWEEN 0 AND 1440);
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'meetings', 'meeting_checkins', 'meeting_outcomes', 'calendar_connections',
    'location_pings', 'location_view_audit', 'tenant_field_settings',
    'geocode_cache', 'drive_time_cache'
  ] LOOP
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
