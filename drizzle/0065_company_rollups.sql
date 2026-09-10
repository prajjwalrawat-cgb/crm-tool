-- 0065 — company_rollups: per-account deal / contact / activity aggregates.
--
-- PROBLEM
-- The Companies list showed Name, Domain, Industry, Created and nothing
-- else. At a few thousand accounts that makes the list a directory, not a
-- worklist: answering "which of these are worth my morning" meant opening
-- records one at a time. The filter chips (Has active deals, Stale,
-- Recently active) already knew the answers, but the table never showed
-- the numbers the chips were filtering on, so a chip's result set was
-- unfalsifiable from the screen.
--
-- SHAPE
-- One `security_invoker` view, rooted at `companies`, with the aggregates
-- computed by correlated LATERAL subqueries rather than by a global
-- `GROUP BY company_id`.
--
-- Why LATERAL and not GROUP BY: the list is keyset-paginated, so 50 of
-- the tenant's companies are wanted, not all of them. A grouped subquery
-- cannot have the outer page's `WHERE id = ANY(...)` pushed into it —
-- Postgres would aggregate every deal, contact, note and activity row in
-- the tenant to decorate 50 rows. A LATERAL is a parameterized index
-- probe per outer row, and a LATERAL cannot be hash-joined, so the plan
-- is forced into a nested loop and LIMIT propagates into the outer scan.
--
-- MEASURED, on a throwaway tenant of 3,000 companies / 6,000 deals /
-- 3,000 contacts / 21,000 activity rows, under `app_user` + the tenant
-- GUCs (EXPLAIN ANALYZE, warm cache):
--
--   companies list as it shipped, no rollups .............  0.09 ms
--   default sort (created_at desc) WITH rollups ..........  2.06 ms
--   page 2 of the same, via keyset cursor ................  2.03 ms
--   "Has active deals" chip + default sort ...............  2.15 ms
--   sort by open_pipeline_value desc .....................  87.2 ms
--   sort by last_activity_at asc .........................  90.0 ms
--
-- The default path plans as
--
--     Limit -> Nested Loop Left Join
--           -> Index Scan companies_tenant_created_keyset_idx (52 rows)
--
-- and stops after 51 outer rows: five index probes each, constant in the
-- size of the tenant. The ~2 ms it adds is well inside the noise of the
-- four round trips every RLS-scoped transaction already costs.
--
-- The two-order-of-magnitude jump on the aggregate sorts is not a
-- regression, it is what a global ranking is: those three modes must
-- score every account the filters admit before they can name the top 50.
-- It is paid only when someone clicks that header.
--
-- CONTRACT — the definitions below are the ONLY definitions. The list's
-- "Has active deals" and "Stale" chips filter on these same columns, so a
-- chip and the column beside it cannot disagree (they did before: the
-- chips read activity_logs, the table read nothing).
--
--   deal_count           every non-deleted deal on the account, any stage
--   open_deal_count      stage NOT IN (won, lost)  -- 'hold' counts as open
--   open_pipeline_value  SUM(amount_minor) over those open deals
--   won_lifetime_value   SUM(amount_minor) over stage = won
--   top_stage            stage of the most recently UPDATED open deal
--                        (NULL when the account has no open deal)
--   contact_count        non-deleted, non-merged contacts
--   last_activity_at     GREATEST of: newest company activity_logs row,
--                        newest company note, newest deal updated_at
--
-- MONEY: amounts are summed in minor units across whatever currencies the
-- account's deals carry, and the UI formats the scalar in the tenant's
-- default currency. Same honest tradeoff the dashboard pipeline tiles
-- already make (see lib/dashboard/queries.ts); a true multi-currency
-- rollup needs FX rates and is its own feature.
--
-- LAST_ACTIVITY BOUNDARY, stated so it does not become folklore: an
-- activity_logs row written against a DEAL (a logged call, a stage change)
-- is not counted directly. It reaches the account only if it also moved
-- deals.updated_at. Counting deal-level activity rows would cost one index
-- probe per deal per company instead of one per company — the difference
-- between this page scaling with accounts and scaling with accounts x
-- deals. The chips previously counted no deal activity at all, so this is
-- strictly more signal, not less.
--
-- ID CASTING: activity_logs.entity_id is a `text` column holding a MIX of
-- shapes — UUIDs for our records, `user_…` / `orginv_…` for Clerk ones.
-- Existing call sites compare it as `entity_id::uuid = c.id`, which (a)
-- needs a regex guard to avoid crashing on the Clerk rows and (b) casts
-- the COLUMN, defeating activity_logs_entity_idx exactly the way migration
-- 0059 documented for the RLS predicates. Here the cast goes on the OTHER
-- side — `entity_id = c.id::text` — so the probe is a plain text equality
-- the index can satisfy, and no Clerk row is ever cast. Verified against
-- production data: every non-lowercase entity_id in the table is an
-- `invitation` or `membership` row; no company/contact/deal id is stored
-- as anything but a canonical lowercase UUID.
--> statement-breakpoint

-- Serves both deal laterals: the aggregate scan over an account's deals,
-- and the ORDER BY updated_at DESC LIMIT 1 that picks top_stage. The
-- open-stage test stays a filter on the index rows rather than a partial
-- index predicate, because the same index has to answer
-- won_lifetime_value too.
CREATE INDEX IF NOT EXISTS "deals_tenant_company_updated_idx"
  ON "deals" ("tenant_id", "company_id", "updated_at" DESC)
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

-- contact_count probes this with both soft-delete predicates already
-- applied, so an account with a long merge history costs a scan of its
-- live rows rather than of every row that ever pointed at it.
CREATE INDEX IF NOT EXISTS "contacts_tenant_company_live_idx"
  ON "contacts" ("tenant_id", "company_id")
  WHERE "deleted_at" IS NULL AND "merged_into_id" IS NULL;
--> statement-breakpoint

-- activity_logs and notes need no new index:
--   activity_logs_entity_idx  (tenant_id, entity_type, entity_id, created_at)
--   notes_tenant_entity_idx   (tenant_id, entity_type, entity_id, created_at)
-- Both are leading-column matches for the laterals below, and both end in
-- created_at, so max(created_at) is answered from the index.
CREATE OR REPLACE VIEW "company_rollups" WITH (security_invoker = true) AS
SELECT
  c."id"                                        AS "company_id",
  c."tenant_id"                                 AS "tenant_id",
  COALESCE(d."deal_count", 0)::int              AS "deal_count",
  COALESCE(d."open_deal_count", 0)::int         AS "open_deal_count",
  COALESCE(d."won_deal_count", 0)::int          AS "won_deal_count",
  COALESCE(d."open_pipeline_value", 0)::bigint  AS "open_pipeline_value",
  COALESCE(d."won_lifetime_value", 0)::bigint   AS "won_lifetime_value",
  t."stage"                                     AS "top_stage",
  COALESCE(ct."contact_count", 0)::int          AS "contact_count",
  GREATEST(al."last_at", nt."last_at", d."last_deal_at") AS "last_activity_at"
FROM "companies" c
-- One pass over the account's deals answers five columns. FILTER beats
-- five correlated subqueries: same index scan, five accumulators.
LEFT JOIN LATERAL (
  SELECT
    count(*)                                                 AS "deal_count",
    count(*) FILTER (WHERE dd."stage" NOT IN ('won','lost'))  AS "open_deal_count",
    count(*) FILTER (WHERE dd."stage" = 'won')                AS "won_deal_count",
    COALESCE(sum(dd."amount_minor") FILTER (WHERE dd."stage" NOT IN ('won','lost')), 0) AS "open_pipeline_value",
    COALESCE(sum(dd."amount_minor") FILTER (WHERE dd."stage" = 'won'), 0)               AS "won_lifetime_value",
    max(dd."updated_at")                                      AS "last_deal_at"
  FROM "deals" dd
  WHERE dd."tenant_id" = c."tenant_id"
    AND dd."company_id" = c."id"
    AND dd."deleted_at" IS NULL
) d ON TRUE
-- top_stage is its own probe, not an aggregate trick, because the tiebreak
-- is "most recently updated OPEN deal" and that is an ordered LIMIT 1 —
-- deals_tenant_company_updated_idx returns it as the first matching row.
LEFT JOIN LATERAL (
  SELECT dd."stage"
  FROM "deals" dd
  WHERE dd."tenant_id" = c."tenant_id"
    AND dd."company_id" = c."id"
    AND dd."deleted_at" IS NULL
    AND dd."stage" NOT IN ('won','lost')
  ORDER BY dd."updated_at" DESC, dd."id" DESC
  LIMIT 1
) t ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*) AS "contact_count"
  FROM "contacts" cc
  WHERE cc."tenant_id" = c."tenant_id"
    AND cc."company_id" = c."id"
    AND cc."deleted_at" IS NULL
    AND cc."merged_into_id" IS NULL
) ct ON TRUE
LEFT JOIN LATERAL (
  SELECT max(a."created_at") AS "last_at"
  FROM "activity_logs" a
  WHERE a."tenant_id" = c."tenant_id"
    AND a."entity_type" = 'company'
    AND a."entity_id" = c."id"::text
) al ON TRUE
LEFT JOIN LATERAL (
  SELECT max(n."created_at") AS "last_at"
  FROM "notes" n
  WHERE n."tenant_id" = c."tenant_id"
    AND n."entity_type" = 'company'
    AND n."entity_id" = c."id"
    AND n."deleted_at" IS NULL
) nt ON TRUE;
--> statement-breakpoint

-- The view carries no policies of its own; security_invoker = true makes
-- every lateral above run under the CALLER's RLS on the base tables, so a
-- rollup can never out-reach the rows that same caller could SELECT
-- directly. Without it a view runs as its OWNER, and this one would have
-- been a cross-tenant read of five tables behind a single SELECT.
GRANT SELECT ON "company_rollups" TO "app_user";
