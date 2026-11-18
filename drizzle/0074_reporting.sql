-- 0074 — Reporting & manager views (build prompt 3).
--
-- SHAPE
--   * memberships.reports_to_user_id — the reporting line. A manager's report
--     scope is themselves + everyone below them (recursive). No teams table yet.
--   * deal_stage_history gains changed_by / owner_id_at_change /
--     source_id_at_change, written by the existing 0045 trigger. This is the
--     funnel backbone; there is no separate lead_stage_history.
--   * organization_settings.timezone now defaults to Asia/Kolkata (it existed,
--     defaulted to UTC and nothing read it) and drives every day bucket.
--     organization_settings.report_narrative_enabled toggles the AI narrative.
--   * report_daily_rollup — per (tenant, day, owner, source) counters,
--     refreshed by Inngest. Unique on an expression (COALESCE(source_id, 0-uuid))
--     because a PRIMARY KEY can't contain an expression.
--   * report_backfill_jobs — resumable historical backfill (cursor by day).
--   * lead_source_cost — monthly spend per source, for ROI.
--   * saved_reports — saved definitions + optional digest schedule.
--   * report_digest_runs — one row per (digest, recipient, period): the
--     idempotency key that makes a re-run send nothing.
--   * report_digest_mutes — per-user opt-out.
--   * report_narrative_cache — 30-minute cache of AI narratives.
--   * report_export_audit — who exported what.

ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "reports_to_user_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_tenant_reports_to_idx"
  ON "memberships" ("tenant_id", "reports_to_user_id") WHERE "reports_to_user_id" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "deal_stage_history"
  ADD COLUMN IF NOT EXISTS "changed_by" text,
  ADD COLUMN IF NOT EXISTS "owner_id_at_change" text,
  ADD COLUMN IF NOT EXISTS "source_id_at_change" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_stage_history_tenant_entered_idx"
  ON "deal_stage_history" ("tenant_id", "entered_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_stage_history_tenant_deal_entered_idx"
  ON "deal_stage_history" ("tenant_id", "deal_id", "entered_at");
--> statement-breakpoint
-- Same behaviour as 0045, plus who / whose / which source at the moment of
-- the change. `app.user_id` is the request actor set by app_set_ctx (0026);
-- 'system' and unset both read as NULL.
CREATE OR REPLACE FUNCTION "deal_stage_history_sync"() RETURNS trigger AS $$
DECLARE
  v_actor text := nullif(nullif(current_setting('app.user_id', true), ''), 'system');
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO "deal_stage_history"
      ("tenant_id", "deal_id", "stage", "entered_at", "exited_at", "changed_by", "owner_id_at_change", "source_id_at_change")
    VALUES
      (NEW."tenant_id", NEW."id", NEW."stage", COALESCE(NEW."created_at", now()), NULL, v_actor, NEW."owner_id", NEW."lead_source_id");
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF (NEW."stage" IS DISTINCT FROM OLD."stage") THEN
      UPDATE "deal_stage_history"
        SET "exited_at" = now()
        WHERE "deal_id" = NEW."id" AND "exited_at" IS NULL;
      INSERT INTO "deal_stage_history"
        ("tenant_id", "deal_id", "stage", "entered_at", "exited_at", "changed_by", "owner_id_at_change", "source_id_at_change")
      VALUES
        (NEW."tenant_id", NEW."id", NEW."stage", now(), NULL, v_actor, NEW."owner_id", NEW."lead_source_id");
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Backfill owner/source on history rows written before this migration: the
-- deal's current owner and source are the best available answer.
UPDATE "deal_stage_history" h
   SET "owner_id_at_change" = d."owner_id",
       "source_id_at_change" = d."lead_source_id"
  FROM "deals" d
 WHERE d."id" = h."deal_id"
   AND h."owner_id_at_change" IS NULL
   AND (d."owner_id" IS NOT NULL OR d."lead_source_id" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "organization_settings" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Kolkata';
--> statement-breakpoint
-- The UTC default was never read by any code path (verified 2026-11-14), so
-- moving untouched rows to the INR-first deployment's zone changes no output.
UPDATE "organization_settings" SET "timezone" = 'Asia/Kolkata' WHERE "timezone" = 'UTC';
--> statement-breakpoint
ALTER TABLE "organization_settings"
  ADD COLUMN IF NOT EXISTS "report_narrative_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- Report-path indexes (EXPLAIN notes in docs/reports.md).
CREATE INDEX IF NOT EXISTS "deals_tenant_created_live_idx"
  ON "deals" ("tenant_id", "created_at") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_tenant_closed_live_idx"
  ON "deals" ("tenant_id", "closed_at") WHERE "deleted_at" IS NULL AND "stage" IN ('won', 'lost');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_logs_tenant_actor_created_idx"
  ON "activity_logs" ("tenant_id", "actor_user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_assignments_tenant_assigned_idx"
  ON "lead_assignments" ("tenant_id", "assigned_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_daily_rollup" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  -- '' = no owner (unassigned lead, system activity). Visible to tenant scope only.
  "owner_id" text NOT NULL,
  "source_id" uuid,
  "leads_created" integer NOT NULL DEFAULT 0,
  "leads_assigned" integer NOT NULL DEFAULT 0,
  "first_touch_count" integer NOT NULL DEFAULT 0,
  "first_touch_within_sla" integer NOT NULL DEFAULT 0,
  "median_first_response_sec" integer,
  "calls_made" integer NOT NULL DEFAULT 0,
  "calls_connected" integer NOT NULL DEFAULT 0,
  "talk_time_sec" integer NOT NULL DEFAULT 0,
  "emails_sent" integer NOT NULL DEFAULT 0,
  "whatsapp_sent" integer NOT NULL DEFAULT 0,
  "meetings_held" integer NOT NULL DEFAULT 0,
  "activities" integer NOT NULL DEFAULT 0,
  "qualified" integer NOT NULL DEFAULT 0,
  "quotes_sent" integer NOT NULL DEFAULT 0,
  "won_count" integer NOT NULL DEFAULT 0,
  "won_value" numeric(14, 2) NOT NULL DEFAULT 0,
  "lost_count" integer NOT NULL DEFAULT 0,
  "refreshed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_daily_rollup_key"
  ON "report_daily_rollup" ("tenant_id", "day", "owner_id", (COALESCE("source_id", '00000000-0000-0000-0000-000000000000'::uuid)));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_daily_rollup_tenant_owner_day_idx"
  ON "report_daily_rollup" ("tenant_id", "owner_id", "day");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_backfill_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "from_day" date NOT NULL,
  "to_day" date NOT NULL,
  -- Next day to process. Each day is committed before the cursor moves, so a
  -- killed job resumes at the first unfinished day.
  "cursor_day" date NOT NULL,
  "days_total" integer NOT NULL,
  "days_done" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "started_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "report_backfill_jobs_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "lead_source_cost" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "lead_sources"("id") ON DELETE CASCADE,
  "month" date NOT NULL,
  "spend" numeric(14, 2) NOT NULL,
  "updated_by" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "source_id", "month"),
  CONSTRAINT "lead_source_cost_month_check" CHECK (extract(day FROM "month") = 1),
  CONSTRAINT "lead_source_cost_spend_check" CHECK ("spend" >= 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "saved_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "owner_id" text NOT NULL,
  "name" text NOT NULL,
  -- {metrics[], groupBy, filters, range, compare}
  "definition" jsonb NOT NULL,
  -- {frequency:'daily'|'weekly', hour, weekday?, recipients[], format:'email'} or NULL
  "schedule" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "saved_reports_tenant_owner_idx" ON "saved_reports" ("tenant_id", "owner_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_digest_runs" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- 'daily' | 'weekly' | 'saved:<id>'
  "digest_key" text NOT NULL,
  "recipient_user_id" text NOT NULL,
  -- The period the digest covers (the day, or the Monday of the week).
  "period" date NOT NULL,
  "status" text NOT NULL DEFAULT 'sent',
  "error" text,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "digest_key", "recipient_user_id", "period")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_digest_mutes" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  -- 'daily' | 'weekly' | 'all'
  "digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "user_id", "digest"),
  CONSTRAINT "report_digest_mutes_digest_check" CHECK ("digest" IN ('daily', 'weekly', 'all'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_narrative_cache" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- hash of (scope users, range, compare)
  "cache_key" text NOT NULL,
  "narrative" jsonb,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "cache_key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "report_export_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "report" text NOT NULL,
  "format" text NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "row_count" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_export_audit_tenant_idx" ON "report_export_audit" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_daily_rollup', 'report_backfill_jobs', 'lead_source_cost', 'saved_reports',
    'report_digest_runs', 'report_digest_mutes', 'report_narrative_cache', 'report_export_audit'] LOOP
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
-- The export audit is append-only for the app.
REVOKE UPDATE, DELETE ON "report_export_audit" FROM app_user;
