-- Phase: notifications.
--
-- Per-user notification stream. Unlike activity_logs (which is a
-- tenant-wide audit feed visible to everyone), notifications are
-- scoped to a single recipient — the row is only readable by the
-- recipient AND only inside the active tenant.
--
-- That double-scope is enforced by RLS using both `app.tenant_id`
-- and `app.user_id`, the same GUCs the existing tenant context
-- already sets per request. No new app plumbing needed.
--
-- Realtime: we reuse the existing `tenant:<id>` SSE channel and the
-- client filters by recipient — simpler than per-user pubsub and the
-- payload is small.

CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "recipient_user_id" text NOT NULL,
  -- null when the trigger is system/automation
  "actor_user_id" text,
  -- Discriminator: task_assigned | deal_won | deal_lost |
  -- owner_changed | task_completed | task_due_soon | comment_mention | …
  "type" text NOT NULL,
  -- Polymorphic link to the entity the notification is about.
  -- null when the notification is not bound to a single row.
  "entity_type" text,
  "entity_id" uuid,
  -- Denormalized for fast list rendering (no extra join needed for
  -- the "you have X new notifications" dropdown).
  "title" text NOT NULL,
  "subtitle" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Per-recipient feed, newest first. Covers the dropdown query.
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("tenant_id","recipient_user_id","created_at");
--> statement-breakpoint
-- Unread badge query — partial index keeps it tiny.
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("tenant_id","recipient_user_id") WHERE "read_at" IS NULL;
--> statement-breakpoint
-- Per-entity lookup so we can purge cascading notifications when an
-- entity is hard-deleted (rare but supported).
CREATE INDEX "notifications_entity_idx" ON "notifications" USING btree ("tenant_id","entity_type","entity_id");
--> statement-breakpoint

-- =============================================================================
-- RLS: tenant scoping + recipient scoping
-- =============================================================================
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- SELECT: only your own notifications in the active tenant.
CREATE POLICY "notifications_recipient_select" ON "notifications"
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
-- INSERT: anyone in the tenant can write — server actions need to
-- create notifications for *other* users (e.g. "I just assigned a
-- task to you"). We don't need a WITH CHECK predicate on
-- recipient_user_id; tenant scoping is what matters.
CREATE POLICY "notifications_tenant_insert" ON "notifications"
  FOR INSERT
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
-- UPDATE: only the recipient can mark their own rows read.
CREATE POLICY "notifications_recipient_update" ON "notifications"
  FOR UPDATE
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
-- DELETE: same as update — recipient owns their stream.
CREATE POLICY "notifications_recipient_delete" ON "notifications"
  FOR DELETE
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND recipient_user_id = current_setting('app.user_id', true)
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO "app_user";
