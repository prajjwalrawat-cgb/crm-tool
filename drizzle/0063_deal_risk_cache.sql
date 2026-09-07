-- 0063_deal_risk_cache.sql
-- Denormalised risk score on `deals`, so the Deals list can SORT by it and
-- the board can render it per card.
--
-- Design notes
-- ------------
-- 1. WHY A CACHE COLUMN AND NOT A JOIN. The deals list paginates with a
--    keyset cursor. Ordering by a column in another table means either a join
--    on every page plus a cursor that straddles two tables, or a subquery in
--    ORDER BY that defeats the index. `deals.health_score` / `health_band`
--    (0050) solved the identical problem the identical way; this follows that
--    precedent rather than inventing a second one.
--
-- 2. `deal_risk_scores` REMAINS THE SOURCE OF TRUTH. These two columns are a
--    cache the nightly job writes in the same transaction as the score row,
--    exactly as the health score's recompute maintains its own cache. The
--    factors, the signals, the explanation and the hash all stay in the
--    scores table — only the two values a list needs to sort and colour by
--    live here.
--
-- 3. NULL MEANS "NOT SCORED", NEVER "NO RISK". A deal that has never been
--    through the job, or that is won/lost/hold, carries NULL — and every
--    query orders NULLs last rather than treating them as zero. Absence of a
--    score is not evidence of safety.

ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "risk_score" smallint;
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "risk_band" text;
--> statement-breakpoint

-- The "sort by risk" keyset: (tenant_id, risk_score DESC, id DESC). Partial,
-- because only open deals ever carry a score and the closed majority would
-- otherwise bloat it.
CREATE INDEX IF NOT EXISTS "deals_tenant_risk_idx"
  ON "deals" ("tenant_id", "risk_score" DESC, "id" DESC)
  WHERE "risk_score" IS NOT NULL;
