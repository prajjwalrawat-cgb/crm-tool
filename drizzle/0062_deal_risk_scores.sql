-- 0062_deal_risk_scores.sql
-- Phase 1 of the predictive layer: a rules-based 0-100 risk score per open
-- deal, plus the LLM-written sentence explaining it.
--
-- Design notes
-- ------------
-- 1. ONE ROW PER DEAL, NOT A HISTORY. `deal_scores` (0050) is append-only
--    because the health score's trend line is a feature. Risk is different:
--    what a manager needs is "what is this deal's risk now", and the daily job
--    would otherwise write one row per open deal per day forever. The unique
--    index makes the recompute an upsert. If a risk trend is wanted later it
--    belongs in `team_metric_snapshots` (0061), which is already the place
--    period-over-period movement lives.
--
-- 2. `signals_hash` IS THE CACHE KEY FOR THE LLM CALL. The score is cheap and
--    deterministic, so it is recomputed every night for every open deal. The
--    explanation costs money and latency, so it is regenerated only when the
--    hash of the scored signals changes. A deal nobody touched costs nothing
--    on the second night — see `explain.ts` for what is and is not in the
--    hash, and why rounding it matters.
--
-- 3. `factors` IS THE FULL BREAKDOWN, not the top three. The prompt sent to
--    Claude carries the top factors, but the card renders all of them and the
--    grounding check in the self-test needs every number the model could have
--    seen. Storing a truncated list would make "did it hallucinate a factor"
--    unanswerable after the fact.
--
-- 4. `explanation` IS NULLABLE and the UI has a deterministic fallback. No API
--    key, a failed call, or a deal scored before the explainer ran all leave
--    it NULL, and the card renders the factor details instead. A score is
--    never blocked on an LLM being reachable.
--
-- 5. Scores are written for OPEN deals only. A row is deleted when its deal
--    closes (see `pruneClosedDealRisk`), so "at risk" can never list a deal
--    that was won last month.

CREATE TABLE IF NOT EXISTS "deal_risk_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- 0-100, higher = more risk. The inverse direction of deals.health_score.
  "score" smallint NOT NULL,
  -- 'low' | 'elevated' | 'high'
  "band" text NOT NULL,
  -- Array<{key, label, points, detail}> — the whole breakdown at compute time.
  "factors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The signals the score was computed from, kept so an explanation can be
  -- audited against exactly what the model was shown.
  "signals" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Claude's one-line "why". NULL until the explainer has run for this hash.
  "explanation" text,
  "explanation_model" text,
  "explained_at" timestamptz,
  -- Cache key: the explanation is regenerated only when this changes.
  "signals_hash" text NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "deal_risk_scores_deal_unique"
  ON "deal_risk_scores" ("deal_id");
--> statement-breakpoint

-- The At Risk view: highest score first within a tenant.
CREATE INDEX IF NOT EXISTS "deal_risk_scores_tenant_score_idx"
  ON "deal_risk_scores" ("tenant_id", "score" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS — same tenant-scoping pattern as 0050 / 0058 / 0060 / 0061. The `::text`
-- cast is on the column, matching 0059's index-eligible form.
-- ---------------------------------------------------------------------------
ALTER TABLE "deal_risk_scores" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_risk_scores" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_risk_scores_tenant_select" ON "deal_risk_scores";
--> statement-breakpoint
CREATE POLICY "deal_risk_scores_tenant_select" ON "deal_risk_scores"
  FOR SELECT USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_risk_scores_tenant_insert" ON "deal_risk_scores";
--> statement-breakpoint
CREATE POLICY "deal_risk_scores_tenant_insert" ON "deal_risk_scores"
  FOR INSERT WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_risk_scores_tenant_update" ON "deal_risk_scores";
--> statement-breakpoint
CREATE POLICY "deal_risk_scores_tenant_update" ON "deal_risk_scores"
  FOR UPDATE USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS "deal_risk_scores_tenant_delete" ON "deal_risk_scores";
--> statement-breakpoint
CREATE POLICY "deal_risk_scores_tenant_delete" ON "deal_risk_scores"
  FOR DELETE USING (tenant_id::text = current_setting('app.tenant_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_risk_scores" TO "app_user";
