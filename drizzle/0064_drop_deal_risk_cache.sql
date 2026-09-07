-- 0064_drop_deal_risk_cache.sql
-- Removes the denormalised risk columns added in 0063.
--
-- WHY THEY ARE GOING AWAY, ONE MIGRATION LATER
-- --------------------------------------------
-- 0063 mirrored `deal_risk_scores.score` onto `deals` so the list could sort
-- by it with a keyset cursor, following the `health_score` precedent. Against
-- live data that turned out to be unwritable for part of the table:
-- `chk_close_date_required` (0060) is NOT VALID, which skips the back-scan but
-- still checks on every UPDATE, so writing any column to a grandfathered
-- dateless Proposal/Negotiation deal aborts the statement.
--
-- Guarding the write around those rows kept the nightly job green and created
-- the bug that mattered: 12 deals showed a risk score on their own page and a
-- dash in the deals list, because the cache had no value for them and the
-- list read only the cache.
--
-- Every surface now reads `deal_risk_scores` through a join instead — one
-- source, one answer, and no row a constraint can silently exclude. Sorting
-- orders by the joined column; at a few hundred open deals per tenant that is
-- a non-issue. Reintroduce a cache only when list ordering actually becomes
-- expensive, and give the dateless deals close dates first.

DROP INDEX IF EXISTS "deals_tenant_risk_idx";
--> statement-breakpoint
ALTER TABLE "deals" DROP COLUMN IF EXISTS "risk_score";
--> statement-breakpoint
ALTER TABLE "deals" DROP COLUMN IF EXISTS "risk_band";
