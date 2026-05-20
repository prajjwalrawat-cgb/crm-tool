-- Phase: organization settings + relationship signals (CP#16C-C Phase A)
--
-- Two new tables backing the operational settings layer and the
-- (read-only-for-now) relationship scoring foundation.
--
-- organization_settings: one row per tenant. UPSERTed on first read.
-- All settings live here as typed columns (not jsonb) so we get real
-- defaults, real CHECKs, and real per-section indexed updates.
--
-- relationship_signals: per-(tenant, entity) rolling counters. v1 is
-- read-only — counters lazy-bumped by the send pipeline in CP#16C-C
-- Phase B; the schema lands now so dependent UI ships with the
-- right shape.

-- 1. organization_settings ----------------------------------------------

CREATE TABLE IF NOT EXISTS "organization_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,

  -- Workspace identity
  "display_name" text,
  "logo_url" text,

  -- Currency + locale
  "default_currency" text NOT NULL DEFAULT 'USD',
  "currency_locale" text NOT NULL DEFAULT 'en-US',
  "locale" text NOT NULL DEFAULT 'en-US',
  "timezone" text NOT NULL DEFAULT 'UTC',
  -- Render large numbers compactly (₹51L instead of ₹51,20,000).
  "compact_numbers" boolean NOT NULL DEFAULT false,
  -- Fiscal-year start. 1 = January. Drives forecast + report ranges.
  "fiscal_year_start_month" smallint NOT NULL DEFAULT 1
    CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12),

  -- Theme + density + a11y
  "default_theme" text NOT NULL DEFAULT 'light'
    CHECK ("default_theme" IN ('light','dark','system')),
  "density" text NOT NULL DEFAULT 'comfortable'
    CHECK ("density" IN ('comfortable','compact')),
  "reduced_motion" boolean NOT NULL DEFAULT false,

  -- Pipeline defaults
  "default_deal_stage" text NOT NULL DEFAULT 'lead'
    CHECK ("default_deal_stage" IN ('lead','qualified','proposal','negotiation','won','lost')),
  "default_report_range" text NOT NULL DEFAULT 'last_30d'
    CHECK ("default_report_range" IN ('today','last_7d','last_30d','last_90d','this_quarter','this_year','all_time')),
  -- Comma-separated metric ids for the dashboard. JSON would be a
  -- jsonb array but this is a tiny preference field and the comma
  -- form is searchable / easy to migrate.
  "dashboard_metrics" text NOT NULL DEFAULT 'pipeline,won,wonRecent,activity',

  -- Email
  "sender_name" text,
  "sender_email" text,
  "default_signature" text,
  "reply_to" text,
  "auto_bcc" text,
  "email_tracking" boolean NOT NULL DEFAULT false,

  -- AI
  "ai_enabled" boolean NOT NULL DEFAULT true,
  "ai_aggressiveness" text NOT NULL DEFAULT 'balanced'
    CHECK ("ai_aggressiveness" IN ('conservative','balanced','aggressive')),
  "insight_refresh" text NOT NULL DEFAULT 'on_change'
    CHECK ("insight_refresh" IN ('on_change','hourly','daily','manual')),

  -- Notifications (org-default; users can override in CP#16C-D)
  "notify_assignments" boolean NOT NULL DEFAULT true,
  "notify_recommendations" boolean NOT NULL DEFAULT true,
  "notify_workflows" boolean NOT NULL DEFAULT true,
  "notify_email_events" boolean NOT NULL DEFAULT true,
  "realtime_enabled" boolean NOT NULL DEFAULT true,

  -- Audit
  "updated_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "organization_settings_tenant_isolation"
  ON "organization_settings"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

-- Seed defaults for existing tenants so getOrgSettings never returns
-- null. Idempotent via ON CONFLICT DO NOTHING.
INSERT INTO "organization_settings" ("tenant_id")
SELECT "id" FROM "tenants"
ON CONFLICT ("tenant_id") DO NOTHING;
--> statement-breakpoint


-- 2. relationship_signals -----------------------------------------------

CREATE TABLE IF NOT EXISTS "relationship_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,

  "last_inbound_at" timestamptz,
  "last_outbound_at" timestamptz,
  "total_inbound" integer NOT NULL DEFAULT 0,
  "total_outbound" integer NOT NULL DEFAULT 0,
  -- Outbound sends with no recorded reply within 7d. Bumped on send,
  -- decremented if a reply lands inside the window.
  "unanswered_count" integer NOT NULL DEFAULT 0,
  -- Rolling average of (their reply at - our send at) in hours.
  "avg_response_hours" real,
  "silent_days" integer NOT NULL DEFAULT 0,
  -- 0..1 derived score. NULL until first computation runs.
  "score" real,
  "status" text NOT NULL DEFAULT 'warming'
    CHECK ("status" IN ('healthy','warming','stale','at_risk')),

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "relationship_signals_entity_unique"
  ON "relationship_signals" ("tenant_id", "entity_type", "entity_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "relationship_signals_status_idx"
  ON "relationship_signals" ("tenant_id", "status", "updated_at" DESC);
--> statement-breakpoint

ALTER TABLE "relationship_signals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "relationship_signals_tenant_isolation"
  ON "relationship_signals"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
