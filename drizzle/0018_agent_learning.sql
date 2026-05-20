-- Phase: agent learning foundation + communications hardening (CP#16C-B)
--
-- Three new tables backing the observation → pattern → recommendation
-- loop. Plus three retry/replay-safety columns on the communications
-- tables shipped in CP#16C-A.
--
-- New tables:
--   agent_observations               append-only event ledger
--   agent_patterns                   derived knowledge (UPSERTed by jobs)
--   agent_recommendation_feedback    accept/ignore/dismiss/complete loop
--
-- Hardening:
--   communication_threads.updated_by      audit who last mutated the thread row
--   communication_threads.last_message_id pointer to the freshest message
--   communication_drafts.deleted_at       soft-delete tombstone (async cleanup later)
--
-- All three new tables are tenant-isolated via RLS on `app_user`.
-- All adds are IF NOT EXISTS / IDEMPOTENT.

-- 1. agent_observations ---------------------------------------------------
--
-- Append-only. No UPDATE path in app code. Two pieces of context:
--   - observation_type: free-text taxonomy ('deal.stage_changed',
--     'email.sent', 'task.completed', 'recommendation.surfaced', etc.).
--   - outcome_score: real number ∈ [-1, 1] used by future RL flows.
--     v1 only fills it on terminal events (win/lost on deals).

CREATE TABLE IF NOT EXISTS "agent_observations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Clerk user id of the actor. NULL for system-emitted observations
  -- (Inngest jobs, automated workflows).
  "actor_user_id" text,
  "observation_type" text NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "outcome_score" real,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Indexed for the derivation scan: per-type, newest-first.
CREATE INDEX IF NOT EXISTS "agent_observations_type_idx"
  ON "agent_observations" ("tenant_id", "observation_type", "created_at" DESC);
--> statement-breakpoint

-- Per-entity recall — used by buildDealContext etc.
CREATE INDEX IF NOT EXISTS "agent_observations_entity_idx"
  ON "agent_observations" ("tenant_id", "entity_type", "entity_id", "created_at" DESC);
--> statement-breakpoint

-- Per-actor recall — "what has this rep been doing?"
CREATE INDEX IF NOT EXISTS "agent_observations_actor_idx"
  ON "agent_observations" ("tenant_id", "actor_user_id", "created_at" DESC);
--> statement-breakpoint

ALTER TABLE "agent_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "agent_observations_tenant_isolation"
  ON "agent_observations"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 2. agent_patterns -------------------------------------------------------
--
-- Derived knowledge. UPSERTed by Inngest derivation jobs; the app never
-- writes here directly. `pattern_key` is a stable hash of the dimensions
-- the pattern correlates (so the same finding re-derived next night
-- updates in-place rather than inserting a duplicate).
--
-- `pattern_data jsonb` is shape-open: SQL-derived stats today, future
-- ML-model outputs tomorrow. Consumers parse the kind they expect.

CREATE TABLE IF NOT EXISTS "agent_patterns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "pattern_type" text NOT NULL,
  "pattern_key" text NOT NULL,
  -- Confidence 0..1. < 0.4 = noise (don't surface). 0.4..0.6 = indicative.
  -- 0.6..0.8 = strong. 0.8+ = high.
  "confidence_score" real NOT NULL DEFAULT 0,
  "supporting_sample_size" integer NOT NULL DEFAULT 0,
  "pattern_data" jsonb NOT NULL DEFAULT '{}',
  -- ISO start/end of the observation window the pattern was derived from.
  -- Lets recommendation runners decide if the finding is fresh enough.
  "learned_from_range" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per (tenant, type, key). Derivation UPSERT relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_patterns_unique"
  ON "agent_patterns" ("tenant_id", "pattern_type", "pattern_key");
--> statement-breakpoint

-- Recommendation lookup: by type, newest-first.
CREATE INDEX IF NOT EXISTS "agent_patterns_type_idx"
  ON "agent_patterns" ("tenant_id", "pattern_type", "updated_at" DESC);
--> statement-breakpoint

ALTER TABLE "agent_patterns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "agent_patterns_tenant_isolation"
  ON "agent_patterns"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 3. agent_recommendation_feedback ----------------------------------------
--
-- One row per (tenant, recommendation, user). Subsequent verdicts UPDATE
-- the same row so the latest signal wins (mirrors ai_feedback's model).
-- `recommendation_id` is the ai_summaries row id of the recommendation
-- set — links a user's verdict back to the model output that produced it.

CREATE TABLE IF NOT EXISTS "agent_recommendation_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- FK to ai_summaries so cascading delete cleans up dangling verdicts.
  "recommendation_id" uuid NOT NULL REFERENCES "ai_summaries"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  -- Optional pointer to the entity the recommendation was about
  -- (deal/company/contact uuid). Lets us aggregate "do reps accept
  -- recommendations on Stage X deals more often than Stage Y?"
  "entity_type" text,
  "entity_id" text,
  "verdict" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_recommendation_feedback_verdict_chk"
    CHECK ("verdict" IN ('accepted','ignored','dismissed','completed'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_recommendation_feedback_unique"
  ON "agent_recommendation_feedback" ("tenant_id", "recommendation_id", "user_id");
--> statement-breakpoint

-- For aggregating verdict trends per entity_type.
CREATE INDEX IF NOT EXISTS "agent_recommendation_feedback_entity_idx"
  ON "agent_recommendation_feedback" ("tenant_id", "entity_type", "created_at" DESC);
--> statement-breakpoint

ALTER TABLE "agent_recommendation_feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "agent_recommendation_feedback_tenant_isolation"
  ON "agent_recommendation_feedback"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
--> statement-breakpoint


-- 4. Hardening: communications retry/replay safety ------------------------

ALTER TABLE "communication_threads"
  ADD COLUMN IF NOT EXISTS "updated_by" text;
--> statement-breakpoint

ALTER TABLE "communication_threads"
  ADD COLUMN IF NOT EXISTS "last_message_id" uuid
    REFERENCES "email_messages"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Soft-delete tombstone for drafts. The send path can mark a draft
-- deleted_at=now() inside the same tx that inserts the message;
-- a nightly cleanup sweep purges rows older than 7 days. This avoids
-- the "send raced with a final autosave" data-loss class.
ALTER TABLE "communication_drafts"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
--> statement-breakpoint

-- Partial index so the per-user drafts list ignores tombstoned rows
-- without needing a NULL check on the hot path.
CREATE INDEX IF NOT EXISTS "communication_drafts_user_live_idx"
  ON "communication_drafts" ("tenant_id", "user_id", "updated_at" DESC)
  WHERE "deleted_at" IS NULL;
