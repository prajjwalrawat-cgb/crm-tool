-- 0073 — Cloud telephony (build prompt 2).
--
-- Click-to-call, inbound matching, call logging + recordings, dispositions,
-- a preview/progressive dialer and AI call summaries. Provider-agnostic;
-- Exotel is the first adapter (see docs/telephony-provider-notes.md).
--
--   * telephony_accounts      provider credentials (AES-256-GCM, key in env
--                             KMS_KEY — never in the DB), caller ids, webhook secret
--   * telephony_settings      per-tenant switches: recording, AI summary (OFF
--                             by default), calling hours, DNC enforcement
--   * user_phone_mapping      the phone the provider rings first for each agent,
--                             plus the agent's softphone status
--   * calls                   one row per call; created BEFORE the provider is
--                             asked to dial, so the first webhook always finds it
--   * dnc_numbers             do-not-call list
--   * call_campaigns / _items dialer queues; items are claimed with
--                             FOR UPDATE SKIP LOCKED
--   * call_recording_access   audit log: every recording play (who, when)
--
-- `calls.lead_id` is the deal id (a lead is a deals row, see 0072).
-- User ids are text, matching users.id.

CREATE TABLE IF NOT EXISTS "telephony_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "label" text,
  "credentials_encrypted" bytea NOT NULL,
  "virtual_numbers" text[] NOT NULL DEFAULT '{}',
  "webhook_secret" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "telephony_accounts_provider_check" CHECK ("provider" IN ('exotel', 'knowlarity', 'ozonetel', 'myoperator', 'twilio', 'mock'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telephony_accounts_tenant_idx" ON "telephony_accounts" ("tenant_id", "is_active");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "telephony_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "record_calls" boolean NOT NULL DEFAULT true,
  -- Plays the provider's "this call may be recorded" announcement where supported.
  "recording_announcement" boolean NOT NULL DEFAULT false,
  "consent_policy_version" text NOT NULL DEFAULT 'v1',
  -- Cloud AI on call audio is opt-in: transcripts + Claude summaries run only when true.
  "ai_call_summary" boolean NOT NULL DEFAULT false,
  "calling_hours" jsonb NOT NULL DEFAULT '{"tz":"Asia/Kolkata","start":"09:00","end":"21:00"}'::jsonb,
  "enforce_dnc" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_phone_mapping" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "agent_phone" text NOT NULL,
  "agent_ext" text,
  -- Softphone bar status. 'available' also sets user_routing_profile.is_available.
  "agent_status" text NOT NULL DEFAULT 'offline',
  "status_changed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "user_phone_mapping_status_check" CHECK ("agent_status" IN ('available', 'on_break', 'offline'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_phone_mapping_phone_idx" ON "user_phone_mapping" ("tenant_id", "agent_phone");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "account_id" uuid REFERENCES "telephony_accounts"("id") ON DELETE SET NULL,
  "provider" text NOT NULL,
  -- 'pending:<calls.id>' until the provider returns its id.
  "provider_call_id" text NOT NULL,
  "direction" text NOT NULL,
  "lead_id" uuid REFERENCES "deals"("id") ON DELETE SET NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "user_id" text,
  "from_number" text NOT NULL,
  "to_number" text NOT NULL,
  "from_number_normalized" text,
  "to_number_normalized" text,
  "status" text NOT NULL,
  "started_at" timestamptz,
  "answered_at" timestamptz,
  "ended_at" timestamptz,
  "duration_sec" integer,
  "talk_time_sec" integer,
  -- Provider URL, short-lived. Internal only: never serialized to a client.
  "recording_url" text,
  -- Our copy in storage. Internal only: never serialized to a client.
  "recording_storage_key" text,
  "recording_archived_at" timestamptz,
  "disposition" text,
  "disposition_at" timestamptz,
  "notes" text,
  "callback_at" timestamptz,
  "transcript" text,
  "ai_summary" jsonb,
  "ai_summary_status" text,
  "follow_up_task_id" uuid,
  "campaign_id" uuid,
  "campaign_item_id" uuid,
  "consent_policy_version" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "calls_provider_call_unique" UNIQUE ("tenant_id", "provider", "provider_call_id"),
  CONSTRAINT "calls_direction_check" CHECK ("direction" IN ('outbound', 'inbound')),
  CONSTRAINT "calls_status_check" CHECK ("status" IN
    ('initiated', 'ringing', 'answered', 'completed', 'no_answer', 'busy', 'failed', 'missed')),
  CONSTRAINT "calls_disposition_check" CHECK ("disposition" IS NULL OR "disposition" IN
    ('connected', 'not_reachable', 'callback', 'interested', 'not_interested', 'wrong_number', 'do_not_call', 'skipped')),
  CONSTRAINT "calls_ai_status_check" CHECK ("ai_summary_status" IS NULL OR "ai_summary_status" IN
    ('pending', 'done', 'transcript_only', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_tenant_lead_idx" ON "calls" ("tenant_id", "lead_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_tenant_user_idx" ON "calls" ("tenant_id", "user_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_tenant_from_idx" ON "calls" ("tenant_id", "from_number_normalized");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_tenant_to_idx" ON "calls" ("tenant_id", "to_number_normalized");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_tenant_created_idx" ON "calls" ("tenant_id", "created_at" DESC);
--> statement-breakpoint
-- Disposition modal: "my calls that ended but have no disposition yet".
CREATE INDEX IF NOT EXISTS "calls_pending_disposition_idx" ON "calls" ("tenant_id", "user_id")
  WHERE "disposition" IS NULL AND "ended_at" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "dnc_numbers" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "phone_normalized" text NOT NULL,
  "reason" text,
  "added_by" text,
  "added_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "phone_normalized")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- No predictive mode in v1 (compliance + abandon-rate risk).
  "mode" text NOT NULL,
  "lead_filter" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "agent_ids" text[] NOT NULL DEFAULT '{}',
  "calling_hours" jsonb NOT NULL DEFAULT '{"tz":"Asia/Kolkata","start":"09:00","end":"21:00"}'::jsonb,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "retry_gap_minutes" integer NOT NULL DEFAULT 120,
  "status" text NOT NULL DEFAULT 'draft',
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "call_campaigns_mode_check" CHECK ("mode" IN ('preview', 'progressive')),
  CONSTRAINT "call_campaigns_status_check" CHECK ("status" IN ('draft', 'running', 'paused', 'completed')),
  CONSTRAINT "call_campaigns_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 20),
  CONSTRAINT "call_campaigns_gap_check" CHECK ("retry_gap_minutes" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_campaigns_tenant_status_idx" ON "call_campaigns" ("tenant_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_campaign_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "call_campaigns"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "lead_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "state" text NOT NULL DEFAULT 'pending',
  "locked_by" text,
  "locked_until" timestamptz,
  "last_call_id" uuid,
  "last_outcome" text,
  "skip_reason" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "call_campaign_items_state_check" CHECK ("state" IN ('pending', 'locked', 'done', 'skipped')),
  CONSTRAINT "call_campaign_items_unique" UNIQUE ("campaign_id", "lead_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_campaign_items_queue_idx" ON "call_campaign_items" ("campaign_id", "state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_campaign_items_lead_idx" ON "call_campaign_items" ("tenant_id", "lead_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_recording_access" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "call_id" uuid NOT NULL REFERENCES "calls"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "range_header" text,
  "accessed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_recording_access_call_idx" ON "call_recording_access" ("tenant_id", "call_id", "accessed_at" DESC);
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['telephony_accounts', 'telephony_settings', 'user_phone_mapping', 'calls',
    'dnc_numbers', 'call_campaigns', 'call_campaign_items', 'call_recording_access'] LOOP
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
-- The recording audit trail is append-only for the app.
REVOKE UPDATE, DELETE ON "call_recording_access" FROM "app_user";
--> statement-breakpoint

-- Provider webhooks arrive with no session: resolve the tenant + secret from
-- the account id in the URL. One row, by id, only what auth needs.
CREATE OR REPLACE FUNCTION "telephony_account_public_lookup"(p_account_id uuid)
RETURNS TABLE (tenant_id uuid, provider text, webhook_secret text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.tenant_id, a.provider, a.webhook_secret, a.is_active
  FROM telephony_accounts a WHERE a.id = p_account_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "telephony_account_public_lookup"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "telephony_account_public_lookup"(uuid) TO app_user;
