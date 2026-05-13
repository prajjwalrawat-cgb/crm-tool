-- Phase: email communication layer.
--
-- Two tables:
--   - email_messages: append-mostly audit of every email sent (or
--     attempted) from the CRM. Direction column is 'outbound' for
--     v1; the schema reserves 'inbound' for future Gmail/Outlook
--     ingestion so the timeline can merge both directions later.
--   - email_drafts: per-user, per-entity working drafts. Cleared on
--     send. Autosave UI is deferred; the table exists so the
--     compose action can persist draft state across page reloads.
--
-- Linking: emails attach to one entity at a time via
-- (entity_type, entity_id). Same loose-FK pattern as tasks/notes/
-- comments — the parent might be soft-deleted; the timeline tolerates.
--
-- Status state machine (email_messages.status):
--   queued     → row created, send not yet attempted
--   sending    → provider call in-flight
--   sent       → provider accepted the message
--   delivered  → reserved (provider-confirmed delivery; v1 leaves at 'sent')
--   failed     → provider rejected; `error` carries the reason
--
-- Idempotency: `idempotency_key` is a unique-per-tenant key the
-- compose action generates client-side. A duplicate POST with the
-- same key returns the existing row instead of double-sending.

CREATE TABLE "email_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "actor_user_id" text NOT NULL,
  -- 'resend' | 'smtp' | 'console' (dev) | future 'gmail' / 'outlook'
  "provider" text NOT NULL,
  -- 'outbound' for v1; 'inbound' reserved.
  "direction" text NOT NULL DEFAULT 'outbound',
  -- 'queued' | 'sending' | 'sent' | 'delivered' | 'failed'
  "status" text NOT NULL DEFAULT 'queued',
  "subject" text NOT NULL,
  "html_body" text,
  "text_body" text NOT NULL,
  "sender" text NOT NULL,
  -- text[] arrays — recipient lists can grow; v1 only uses `to_recipients`.
  "to_recipients" text[] NOT NULL DEFAULT '{}',
  "cc_recipients" text[] NOT NULL DEFAULT '{}',
  "bcc_recipients" text[] NOT NULL DEFAULT '{}',
  -- Polymorphic link to one CRM entity. Null = standalone (rare).
  "entity_type" text,
  "entity_id" uuid,
  -- Provider's message id once accepted. Useful for future webhook
  -- delivery-confirmation handlers.
  "provider_message_id" text,
  -- Per-tenant unique key for idempotent retries.
  "idempotency_key" text,
  "error" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "email_messages_tenant_created_idx" ON "email_messages" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX "email_messages_tenant_entity_idx" ON "email_messages" USING btree ("tenant_id","entity_type","entity_id","created_at");
--> statement-breakpoint
CREATE INDEX "email_messages_tenant_actor_idx" ON "email_messages" USING btree ("tenant_id","actor_user_id");
--> statement-breakpoint
CREATE INDEX "email_messages_tenant_status_idx" ON "email_messages" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_idempotency_idx" ON "email_messages" USING btree ("tenant_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "email_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "actor_user_id" text NOT NULL,
  "subject" text NOT NULL DEFAULT '',
  "text_body" text NOT NULL DEFAULT '',
  "to_recipients" text[] NOT NULL DEFAULT '{}',
  "cc_recipients" text[] NOT NULL DEFAULT '{}',
  "bcc_recipients" text[] NOT NULL DEFAULT '{}',
  "entity_type" text,
  "entity_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "email_drafts_tenant_author_idx" ON "email_drafts" USING btree ("tenant_id","actor_user_id","updated_at");
--> statement-breakpoint
CREATE INDEX "email_drafts_tenant_entity_idx" ON "email_drafts" USING btree ("tenant_id","entity_type","entity_id");
--> statement-breakpoint

-- =============================================================================
-- RLS: email_messages — tenant scoping. Reads/writes go through the
-- standard app.tenant_id GUC. Logs are never UPDATE-d after the
-- terminal status is set in app code; we still allow UPDATE for the
-- queued → sending → sent transition.
-- =============================================================================
ALTER TABLE "email_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "email_messages_tenant_select" ON "email_messages"
  FOR SELECT
  USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "email_messages_tenant_insert" ON "email_messages"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "email_messages_tenant_update" ON "email_messages"
  FOR UPDATE
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "email_messages" TO "app_user";
--> statement-breakpoint

-- =============================================================================
-- RLS: email_drafts — author-scoped within the tenant. Each user
-- only sees and edits their own drafts; the tenant predicate stops
-- cross-tenant reads, the author predicate stops cross-user reads.
-- =============================================================================
ALTER TABLE "email_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_drafts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "email_drafts_author_select" ON "email_drafts"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND actor_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
CREATE POLICY "email_drafts_tenant_insert" ON "email_drafts"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
CREATE POLICY "email_drafts_author_update" ON "email_drafts"
  FOR UPDATE
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND actor_user_id = current_setting('app.user_id', true)
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND actor_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
CREATE POLICY "email_drafts_author_delete" ON "email_drafts"
  FOR DELETE
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND actor_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_drafts" TO "app_user";
