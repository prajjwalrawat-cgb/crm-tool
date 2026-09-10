-- 0066 — offerings: what the deal is actually selling.
--
-- PROBLEM
-- A deal carries a name, an amount and a stage, and nothing that says
-- WHICH THING is being sold. "Acme — annual contract" could be
-- SafeOps360, a recruitment retainer, or an implementation project, and
-- the pipeline number is the same either way. So the one question the
-- business asks every month — "how is SafeOps360 doing versus
-- AnytimeHire?" — is answerable only by reading deal names, and the
-- Product-vs-Service split (which have different margins, different
-- delivery costs and different people) does not exist in the data at all.
--
-- SHAPE
-- A tenant-scoped catalog (`offerings`) plus a join table
-- (`deal_offerings`), NOT an enum column on `deals` and NOT a single FK.
--
--   * A catalog, because the list changes. Adding LUMINEX or retiring a
--     product must be a row insert an admin can do from Settings, not an
--     `ALTER TYPE` and a deploy.
--   * Tenant-scoped, because every other table here is. The seed list is
--     this deployment's own portfolio, not a universal taxonomy, and a
--     second workspace must be able to carry a different one.
--   * MANY-to-many, because bundle deals are the norm: SafeOps360 sold
--     with Implementation Services is one deal, one amount, and it has to
--     appear in BOTH funnels. Squeezing it into one FK would force the
--     reporting question "which offerings are we selling" to be answered
--     with "whichever one the rep picked first".
--
-- THE PRIMARY FLAG, AND WHAT IT IS *NOT* FOR
-- `deal_offerings.is_primary` marks the one offering that best labels the
-- deal. It exists so the deals TABLE can show one chip per row instead of
-- five, and so per-offering primary rollups can attribute a deal's amount
-- exactly once when that matters.
--
-- It is deliberately NOT what the funnel report filters on. A deal tagged
-- Product + Service counts in full toward BOTH offerings' funnels — that
-- is the point of the join table, and it means the per-offering funnel
-- values SUM TO MORE than total pipeline when bundles exist. That is
-- correct and load-bearing, not a double-count bug: the question "what is
-- the SafeOps360 funnel" is asking about every deal SafeOps360 is part of.
-- Anything that needs a partition of the pipeline (never more than 100%)
-- must use is_primary; anything asking about an offering's own book uses
-- all tags. The report labels which one it is doing.
--
-- WHY `is_primary` HAS A PARTIAL UNIQUE INDEX EVEN THOUGH THE APP MANAGES IT
-- The spec asks for app-level enforcement (unset the old primary when a
-- new one is marked), and the actions do exactly that. The index below is
-- the backstop, on the same reasoning as 0045's identical index on
-- `deal_contacts`: "exactly one" is an invariant every future write path
-- would have to remember, and there are already four of them here (create,
-- detail-card add, detail-card set-primary, remove-and-promote). A second
-- primary is silent corruption — the list column would pick one at random
-- per query plan — so the DB refuses it rather than letting it land.
--
-- NO BACKFILL. Deliberate.
-- Every deal that exists today stays untagged, and reads as
-- "Uncategorized" everywhere. There is no defensible automatic mapping
-- from a free-text deal name to an offering, and a guessed tag is worse
-- than an absent one: it would be invisible in the UI and wrong in the
-- reports. The coverage gap is instead made VISIBLE — the funnel report
-- carries an explicit Uncategorized total, and the deals list has an
-- Uncategorized filter — so the team works the backlog down at its own
-- pace and can always see how much is left.
--
-- DELETION. `deal_offerings.offering_id` is ON DELETE NO ACTION, not
-- CASCADE. Offerings are retired with `active = false`, which keeps them
-- rendering on the deals that carry them while removing them from the
-- picker for new tagging. The FK makes "never hard-delete a referenced
-- offering" structural rather than a rule in a comment: an accidental
-- DELETE fails loudly instead of quietly rewriting closed-won history.
--
-- NO ACTION and not RESTRICT, and the difference is load-bearing here.
-- Both refuse a bare `DELETE FROM offerings` that would orphan tags, but
-- RESTRICT is checked IMMEDIATELY while NO ACTION is checked at the end of
-- the statement. Dropping a tenant cascades into `offerings` and into
-- `deal_offerings` in whatever order the RI triggers happen to fire; under
-- RESTRICT, an `offerings` cascade that runs first sees tag rows that are
-- about to be deleted and aborts, so deleting a workspace would fail. NO
-- ACTION lets the sibling cascades finish and then finds nothing left to
-- orphan. Same guarantee for the case we care about, no self-inflicted
-- deadlock on the case we don't.

CREATE TYPE "offering_category" AS ENUM ('product', 'service');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "offerings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "category" "offering_category" NOT NULL,
  -- Retirement flag. Never delete: historical deals reference these rows.
  "active" boolean NOT NULL DEFAULT true,
  -- Display order WITHIN a category. Ties break by name so the list is
  -- stable before anyone has reordered anything.
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Case-insensitive uniqueness per workspace. "SafeOps360" and "safeops360"
-- as two catalog entries would split one product's funnel in half, which is
-- the exact failure this feature exists to prevent. Scoped to tenant, so two
-- workspaces may each carry their own "Implementation Services".
CREATE UNIQUE INDEX IF NOT EXISTS "offerings_tenant_name_unique"
  ON "offerings" ("tenant_id", lower("name"));
--> statement-breakpoint

-- The Settings list and the tag picker both read (tenant, category,
-- sort_order, name) in that order; this answers both from the index.
CREATE INDEX IF NOT EXISTS "offerings_tenant_category_order_idx"
  ON "offerings" ("tenant_id", "category", "sort_order", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deal_offerings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- NO ACTION, not CASCADE — see the deletion note at the top.
  "offering_id" uuid NOT NULL REFERENCES "offerings"("id") ON DELETE NO ACTION,
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One tag per (deal, offering). Re-tagging is idempotent rather than
-- additive, so a double-submit can't double a deal into its own funnel.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_offerings_deal_offering_unique"
  ON "deal_offerings" ("deal_id", "offering_id");
--> statement-breakpoint

-- At most one primary per deal. The backstop described at the top.
CREATE UNIQUE INDEX IF NOT EXISTS "deal_offerings_one_primary_per_deal"
  ON "deal_offerings" ("deal_id") WHERE "is_primary";
--> statement-breakpoint

-- The deals list joins (deal_id, is_primary) to render one chip per row.
CREATE INDEX IF NOT EXISTS "deal_offerings_tenant_deal_idx"
  ON "deal_offerings" ("tenant_id", "deal_id");
--> statement-breakpoint

-- The funnel report drives FROM an offering: "give me every deal tagged
-- SafeOps360". Without this the report is a seq scan of every tag row in
-- the workspace per stage bucket.
CREATE INDEX IF NOT EXISTS "deal_offerings_tenant_offering_idx"
  ON "deal_offerings" ("tenant_id", "offering_id");
--> statement-breakpoint

ALTER TABLE "offerings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "deal_offerings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Policies use the uuid-to-uuid predicate 0059 standardised on, NOT the
-- `tenant_id::text = current_setting(...)` form the older migrations wrote.
-- 0059 runs BEFORE this file in the build chain, so a policy written in the
-- old shape here would never be rewritten and would silently seq-scan.
CREATE POLICY "offerings_tenant_select" ON "offerings"
  FOR SELECT USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "offerings_tenant_insert" ON "offerings"
  FOR INSERT WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "offerings_tenant_update" ON "offerings"
  FOR UPDATE USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "offerings_tenant_delete" ON "offerings"
  FOR DELETE USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint

CREATE POLICY "deal_offerings_tenant_select" ON "deal_offerings"
  FOR SELECT USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "deal_offerings_tenant_insert" ON "deal_offerings"
  FOR INSERT WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "deal_offerings_tenant_update" ON "deal_offerings"
  FOR UPDATE USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint
CREATE POLICY "deal_offerings_tenant_delete" ON "deal_offerings"
  FOR DELETE USING (tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "offerings" TO "app_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_offerings" TO "app_user";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- SEED — this deployment's portfolio, into every workspace that exists.
--
-- Runs as the migration role (RLS-exempt), so it can cross tenants; the app
-- never can. `ON CONFLICT DO NOTHING` against the case-insensitive unique
-- index makes a re-run a no-op, and — more importantly — makes it safe
-- against a workspace where an admin has already renamed or added entries:
-- the seed will not resurrect or overwrite anything.
--
-- Deactivated entries are NOT reactivated either, for the same reason. An
-- admin who retired ProcureFlow last month does not want it back on the next
-- deploy.
--
-- sort_order is spaced by 10 so a later manual insert can land between two
-- rows without renumbering the whole category.
-- ---------------------------------------------------------------------------
INSERT INTO "offerings" ("tenant_id", "name", "category", "sort_order")
SELECT t."id", v."name", v."category"::"offering_category", v."sort_order"
FROM "tenants" t
CROSS JOIN (VALUES
  ('SafeOps360',              'product',  10),
  ('Expenses Tool',           'product',  20),
  ('CRM (Saleinx)',           'product',  30),
  ('AnytimeHire',             'product',  40),
  ('ProcureFlow',             'product',  50),
  ('VisitOS',                 'product',  60),
  ('Cadence',                 'product',  70),
  ('LUMINEX',                 'product',  80),
  ('Velantis',                'product',  90),
  ('Recruitment',             'service',  10),
  ('Contract Manpower',       'service',  20),
  ('Implementation Services', 'service',  30),
  ('DC Support',              'service',  40),
  ('Infra Support',           'service',  50)
) AS v("name", "category", "sort_order")
ON CONFLICT DO NOTHING;
