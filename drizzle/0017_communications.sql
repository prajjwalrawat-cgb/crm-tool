-- Phase: communication center foundation (CP#16C-A)
--
-- Introduces a normalized communication graph that the inbox renders
-- from. `email_messages` is unchanged on disk; one new nullable column
-- (`thread_id`) links existing rows into the new threads table once
-- the backfill job runs. The inbox query never touches email_messages
-- on the hot path — it scans communication_threads only.
--
-- Five new tables:
--   communication_threads        one row per logical conversation
--   communication_participants   one row per (thread, address)
--   communication_drafts         server-authoritative per-user draft
--   communication_events         append-only state ledger
--   communication_analytics      daily rollup for the dashboard
--
-- All five are tenant-isolated via RLS on `app_user`. Indexes are
-- cursor-ready from day one — `(last_message_at DESC, id DESC)` for
-- the inbox is identical to the pattern the rest of the app uses.
--
-- Idempotent: every CREATE uses IF NOT EXISTS; the column add is
-- IF NOT EXISTS. Safe to re-run.

-- 1. communication_threads --------------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,

  -- Optional CRM context. A thread "about a deal" lights up the deal
  -- timeline; standalone threads (no linked entity) still render in
  -- the inbox.
  "entity_type" text,
  "entity_id" uuid,

  -- subject_raw is preserved exactly as the user typed it; the
  -- normalized form (lowercased, Re:/Fwd: stripped, whitespace
  -- collapsed) drives subject-based reply grouping at write time.
  "subject_raw" text NOT NULL DEFAULT '',
  "subject_normalized" text NOT NULL DEFAULT '',

  -- First ~140 chars of the latest message body. Lets the inbox
  -- render a one-line preview without joining email_messages.
  "message_preview" text,

  -- Lifecycle. Spam is reserved for future bounce/spam detection.
  "thread_status" text NOT NULL DEFAULT 'active',

  -- Aggregate hints — denormalized into the thread row so the inbox
  -- can render counters without per-thread aggregation. Updated by
  -- the same write path that inserts events.
  "has_attachments" boolean NOT NULL DEFAULT false,
  "last_message_at" timestamptz NOT NULL DEFAULT now(),
  "last_summary_id" uuid REFERENCES "ai_summaries"("id") ON DELETE SET NULL,
  "message_count" integer NOT NULL DEFAULT 0,
  "unread_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "communication_threads_status_chk"
    CHECK ("thread_status" IN ('active','archived','muted','spam'))
);
--> statement-breakpoint

-- Inbox scan (cursor-ready). Newest-first by (last_message_at, id).
CREATE INDEX IF NOT EXISTS "communication_threads_inbox_idx"
  ON "communication_threads" ("tenant_id", "last_message_at" DESC, "id" DESC);
--> statement-breakpoint

-- Per-entity timeline join.
CREATE INDEX IF NOT EXISTS "communication_threads_entity_idx"
  ON "communication_threads" ("tenant_id", "entity_type", "entity_id");
--> statement-breakpoint

-- Subject reply grouping at write time.
CREATE INDEX IF NOT EXISTS "communication_threads_subject_idx"
  ON "communication_threads" ("tenant_id", "subject_normalized");
--> statement-breakpoint

-- Partial: active threads only. Used by the default inbox view.
CREATE INDEX IF NOT EXISTS "communication_threads_active_idx"
  ON "communication_threads" ("tenant_id", "last_message_at" DESC)
  WHERE "thread_status" = 'active';
--> statement-breakpoint

-- Partial: threads with any failed delivery. Used by the "Failed"
-- inbox section.
CREATE INDEX IF NOT EXISTS "communication_threads_failed_idx"
  ON "communication_threads" ("tenant_id", "last_message_at" DESC)
  WHERE "failed_count" > 0;
--> statement-breakpoint

-- Partial: threads with any unread message. The bell + inbox unread
-- badge read this.
CREATE INDEX IF NOT EXISTS "communication_threads_unread_idx"
  ON "communication_threads" ("tenant_id", "last_message_at" DESC)
  WHERE "unread_count" > 0;
--> statement-breakpoint

ALTER TABLE "communication_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "communication_threads_tenant_isolation"
  ON "communication_threads"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 2. communication_participants --------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "thread_id" uuid NOT NULL REFERENCES "communication_threads"("id") ON DELETE CASCADE,
  "email_address" text NOT NULL,
  "participant_role" text NOT NULL,
  -- Optional FK to a CRM contact. Nullable because we receive mail
  -- from addresses we don't know about; the inbox still threads them.
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "communication_participants_role_chk"
    CHECK ("participant_role" IN ('from','to','cc','bcc'))
);
--> statement-breakpoint

-- One row per (thread, address, role). De-dups CC repeats.
CREATE UNIQUE INDEX IF NOT EXISTS "communication_participants_unique"
  ON "communication_participants"
  ("tenant_id", "thread_id", "email_address", "participant_role");
--> statement-breakpoint

-- Per-thread lookup at render time.
CREATE INDEX IF NOT EXISTS "communication_participants_thread_idx"
  ON "communication_participants" ("tenant_id", "thread_id");
--> statement-breakpoint

-- Cross-thread search by address (e.g. "all threads with alice@…").
CREATE INDEX IF NOT EXISTS "communication_participants_address_idx"
  ON "communication_participants" ("tenant_id", "email_address");
--> statement-breakpoint

ALTER TABLE "communication_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "communication_participants_tenant_isolation"
  ON "communication_participants"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 3. communication_drafts --------------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,

  -- Discriminates the editing context. Lets a user have a 'reply'
  -- draft on thread X and a 'new' draft about deal X open simultaneously.
  "context_kind" text NOT NULL DEFAULT 'new',
  "thread_id" uuid REFERENCES "communication_threads"("id") ON DELETE SET NULL,
  "entity_type" text,
  "entity_id" uuid,

  "subject" text NOT NULL DEFAULT '',
  "body_html" text,
  "body_text" text NOT NULL DEFAULT '',

  "to_recipients" text[] NOT NULL DEFAULT '{}',
  "cc_recipients" text[] NOT NULL DEFAULT '{}',
  "bcc_recipients" text[] NOT NULL DEFAULT '{}',

  -- Optimistic-concurrency token. Incremented on every server-side
  -- write; clients send their last-seen version on save and the
  -- server rejects writes whose version is behind.
  "version" integer NOT NULL DEFAULT 1,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "communication_drafts_context_chk"
    CHECK ("context_kind" IN ('new','reply','forward'))
);
--> statement-breakpoint

-- One draft per (user, context). `thread_id` and `entity_id` are
-- coalesced into stable text via the UNIQUE expression below so a
-- user can have one draft per "place".
CREATE UNIQUE INDEX IF NOT EXISTS "communication_drafts_user_context_unique"
  ON "communication_drafts" (
    "tenant_id",
    "user_id",
    "context_kind",
    COALESCE("thread_id"::text, ''),
    COALESCE("entity_id"::text, ''),
    COALESCE("entity_type", '')
  );
--> statement-breakpoint

-- Per-user list at the inbox "Drafts" tab.
CREATE INDEX IF NOT EXISTS "communication_drafts_user_updated_idx"
  ON "communication_drafts" ("tenant_id", "user_id", "updated_at" DESC);
--> statement-breakpoint

ALTER TABLE "communication_drafts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "communication_drafts_tenant_isolation"
  ON "communication_drafts"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 4. communication_events --------------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "thread_id" uuid REFERENCES "communication_threads"("id") ON DELETE CASCADE,
  "message_id" uuid REFERENCES "email_messages"("id") ON DELETE CASCADE,

  -- Kind covers everything from sent to opened/clicked. No provider
  -- assumption — webhook handlers map provider-specific shapes onto
  -- this neutral vocabulary.
  "event_kind" text NOT NULL,

  -- The provider that emitted the event. NULL when emitted by us
  -- (e.g. our own send-attempt log). Free-text — adding a new
  -- provider doesn't need a schema change.
  "provider" text,

  -- Provider-specific opaque details (webhook payload, etc.) for
  -- audit/troubleshooting. Never read by the inbox hot path.
  "metadata" jsonb NOT NULL DEFAULT '{}',

  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "communication_events_kind_chk"
    CHECK ("event_kind" IN (
      'sent','queued','delivered','failed','retried',
      'opened','clicked','replied','bounced'
    ))
);
--> statement-breakpoint

-- Per-thread state walk (timeline render).
CREATE INDEX IF NOT EXISTS "communication_events_thread_idx"
  ON "communication_events" ("tenant_id", "thread_id", "created_at" DESC);
--> statement-breakpoint

-- Per-message state walk (delivery audit).
CREATE INDEX IF NOT EXISTS "communication_events_message_idx"
  ON "communication_events" ("tenant_id", "message_id", "created_at" DESC);
--> statement-breakpoint

-- Tenant-wide newest-first (analytics queries).
CREATE INDEX IF NOT EXISTS "communication_events_tenant_kind_idx"
  ON "communication_events" ("tenant_id", "event_kind", "created_at" DESC);
--> statement-breakpoint

ALTER TABLE "communication_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "communication_events_tenant_isolation"
  ON "communication_events"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 5. communication_analytics ----------------------------------------------

CREATE TABLE IF NOT EXISTS "communication_analytics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,

  -- Day key (UTC). Rollups are per-day.
  "metric_day" date NOT NULL,
  -- Metric name — string so adding a new metric (engagement_score,
  -- avg_response_seconds, …) doesn't require a schema change.
  "metric_name" text NOT NULL,
  "metric_value" numeric(18, 6) NOT NULL DEFAULT 0,

  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per (tenant, day, metric). Upserted by the nightly job.
CREATE UNIQUE INDEX IF NOT EXISTS "communication_analytics_unique"
  ON "communication_analytics" ("tenant_id", "metric_day", "metric_name");
--> statement-breakpoint

-- Trend reads (90-day windows on the dashboard).
CREATE INDEX IF NOT EXISTS "communication_analytics_trend_idx"
  ON "communication_analytics" ("tenant_id", "metric_name", "metric_day" DESC);
--> statement-breakpoint

ALTER TABLE "communication_analytics" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "communication_analytics_tenant_isolation"
  ON "communication_analytics"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 6. email_messages.thread_id ---------------------------------------------
--
-- Backwards-compatible link from existing messages to the new threads
-- table. Nullable: the backfill job populates it; new sends populate
-- it inline. We don't add a NOT NULL constraint so the migration can
-- roll forward without forcing a UPDATE of every existing row.

ALTER TABLE "email_messages"
  ADD COLUMN IF NOT EXISTS "thread_id" uuid
    REFERENCES "communication_threads"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "email_messages_thread_idx"
  ON "email_messages" ("tenant_id", "thread_id");
