-- 0051_gmail_sync.sql
-- Phase 2 / Module 3 (Automatic Email Activity Capture — Gmail). Per-user Gmail
-- connection table + an idempotency guard on email_messages so re-running the
-- sync can never create duplicate inbound rows.

-- ---------------------------------------------------------------------------
-- gmail_connections: one row per (tenant, user). Encrypted refresh token.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "gmail_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "email" text NOT NULL,
  "refresh_token_enc" text NOT NULL,
  "access_token_enc" text,
  "access_token_expires_at" timestamptz,
  "history_id" text,
  "last_sync_at" timestamptz,
  "sync_status" text NOT NULL DEFAULT 'active',
  "last_error" text,
  "excluded_domains" text[] NOT NULL DEFAULT '{}',
  "excluded_addresses" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gmail_connections_tenant_user_uniq"
  ON "gmail_connections" ("tenant_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gmail_connections_tenant_status_idx"
  ON "gmail_connections" ("tenant_id", "sync_status");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- email_messages: idempotency for synced Gmail messages. Scoped to gmail so it
-- can never collide with existing outbound (resend/smtp) rows. A re-sync of the
-- same Gmail message id is a no-op (ON CONFLICT DO NOTHING).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_gmail_provider_msg_uniq"
  ON "email_messages" ("tenant_id", "provider_message_id")
  WHERE "provider" = 'gmail' AND "provider_message_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- communication_events: allow the new 'received' kind (inbound synced email).
-- Recreate the CHECK constraint (0017) with the extra value.
-- ---------------------------------------------------------------------------
ALTER TABLE "communication_events"
  DROP CONSTRAINT IF EXISTS "communication_events_kind_chk";
--> statement-breakpoint
ALTER TABLE "communication_events"
  ADD CONSTRAINT "communication_events_kind_chk"
  CHECK ("event_kind" IN (
    'sent','queued','delivered','failed','retried',
    'opened','clicked','replied','bounced','received'
  ));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS: same tenant-scoping pattern as 0049 / 0050.
-- ---------------------------------------------------------------------------
ALTER TABLE "gmail_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "gmail_connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "gmail_connections_tenant_select" ON "gmail_connections"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "gmail_connections_tenant_insert" ON "gmail_connections"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "gmail_connections_tenant_update" ON "gmail_connections"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "gmail_connections_tenant_delete" ON "gmail_connections"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "gmail_connections" TO "app_user";
