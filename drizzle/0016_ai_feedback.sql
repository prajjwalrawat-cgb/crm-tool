-- Phase: AI feedback (CP#16A step 1)
--
-- Adds a thumbs-up/down/dismiss table for AI-generated insights. One
-- row per (tenant, summary, user) — subsequent verdicts UPDATE that
-- row, not append, so the latest signal wins.
--
-- The aggregated read query (helpful-rate per insight type) feeds
-- prompt tuning. v1 just collects.

CREATE TABLE IF NOT EXISTS "ai_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "summary_id" uuid NOT NULL REFERENCES "ai_summaries"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "verdict" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ai_feedback_user_summary_unique"
  ON "ai_feedback" ("tenant_id", "summary_id", "user_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ai_feedback_tenant_created_idx"
  ON "ai_feedback" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

-- Enable RLS. App reads via `app_user` role with the standard tenant
-- GUC; system writes (Inngest jobs) bypass via the service role.
ALTER TABLE "ai_feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "ai_feedback_tenant_isolation"
  ON "ai_feedback"
  FOR ALL
  TO "app_user"
  USING ("tenant_id"::text = current_setting('app.tenant_id', true))
  WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));
