-- 0067 — make Offerings a per-workspace feature.
--
-- PROBLEM
-- 0066 shipped Offerings to every workspace at once: a mandatory picker on
-- the create form, a column and filter on the deals list, a card on the
-- detail page, a report. But the catalog it seeded is CGB Solutions' own
-- portfolio (SafeOps360, AnytimeHire, ...). A second company on the same
-- deployment — ArtBox Solutions is the live example — was suddenly unable
-- to create a deal without tagging it with products it doesn't sell.
--
-- SHAPE
-- One more boolean on `workspace_settings`, next to the Phase-2 module
-- flags, following the convention 0049 set: a coarse kill-switch per
-- tenant, default OFF, flipped from the feature's own Settings page.
-- OFF means the feature is invisible AND inert — no picker, no mandatory
-- rule, no column, no filter, no card, no report. It does NOT mean the data
-- is deleted: turning it off keeps every catalog row and every tag, and
-- turning it back on restores the lot exactly as it was.
--
-- WHO STARTS ON
-- The column default is OFF, so every workspace that exists after this
-- migration without an explicit flip — and every workspace created later —
-- stays dark until an admin opts in.
--
-- The UPDATE below then turns it ON for workspaces that were already using
-- it, decided by DATA rather than by name wherever possible: any tenant with
-- at least one tagged deal. At the time of writing that is exactly CGB
-- Solutions and Test11 (the demo workspace). CGB is also matched by name,
-- per the Phase-2 convention (`name ILIKE '%CGB%'`), so its flag comes on
-- even on an environment where nobody has tagged a CGB deal yet.
--
-- Everyone else — ArtBox included, 209 deals and zero tags — starts OFF,
-- which is the point of this migration. No workspace loses data it entered,
-- and no workspace gains a mandatory field it never asked for.
--> statement-breakpoint

ALTER TABLE "workspace_settings"
  ADD COLUMN IF NOT EXISTS "offerings_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- INSERT ... ON CONFLICT rather than a bare UPDATE: `workspace_settings` rows
-- are created LAZILY on first read (see getWorkspaceSettings), so a tenant
-- that has never opened a Phase-2 page has no row for an UPDATE to hit — and
-- would fall through to the column default of OFF on its next read.
--
-- ONE-SHOT. The build chain re-runs every apply script on every deploy, and
-- this statement cannot tell "still at the default" apart from "an admin
-- switched it off" — both are `false`. Replayed, it would switch Offerings
-- back ON for CGB on the next deploy after an admin turned it off. So
-- `scripts/apply-0067.ts` checks its marker in `drizzle.__drizzle_migrations`
-- and skips this whole file once it has run. Do not paste this statement
-- into an apply script without that guard.
INSERT INTO "workspace_settings" ("tenant_id", "offerings_enabled")
SELECT t."id", true
FROM "tenants" t
WHERE t."name" ILIKE '%CGB%'
   OR EXISTS (
     SELECT 1
     FROM "deal_offerings" dof
     JOIN "deals" d ON d."id" = dof."deal_id" AND d."deleted_at" IS NULL
     WHERE dof."tenant_id" = t."id"
   )
ON CONFLICT ("tenant_id") DO UPDATE SET
  "offerings_enabled" = true,
  "updated_at" = now();
