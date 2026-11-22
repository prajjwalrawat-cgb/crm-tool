# Prospect Board, Stage 4 (Manager report + README) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give managers a Prospect Board report and document the feature for whoever deploys and runs it. The report covers prospects added per rep and per source, prospect→lead conversion % by source, cluster tag and rep, average days in each stage, and a stale count.

**Architecture:** One new report in the existing Reports module:
- a query/runner at `src/lib/reports/queries/prospect-board.ts`;
- a section component at `src/app/dashboard/reports/_components/prospect-board-section.tsx`;
- a registry entry in `src/lib/reports/registry.ts`.

It reuses the module's date-range filter, owner-scope handling, CSV export and detail page at `/dashboard/reports/[reportId]`. It reads only existing tables (`prospects`, `prospect_stage_history`), so there is no migration. A "Report" link on the board goes to it. The README gets a "Prospect Board" section.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before page code), Drizzle/SQL, existing reports infra, tsx selftests.

**Spec:** `docs/superpowers/specs/2026-11-22-prospect-board-design.md`, section "Reporting (stage 4)".

## Global Constraints

- Tests run only against the Docker test DB (`crm-test-pg`, port 15434, via `.env.local`). Never the `.env` (production) DB. **No real Anthropic API calls**: any test or script process blanks `ANTHROPIC_API_KEY` after dotenv loads (user decision 2026-11-22).
- Access: `viewProspectReports` (owner, admin, manager). Managers see rows only for users in their `scopeUsers` team (`src/lib/reports/manager/scope.ts`); owner/admin see everyone. Members and viewers get the normal "not allowed" path the reports module uses, and the board link is hidden for them.
- **Definitions** (exact):
  - **Cohort:** prospects with `created_at` in the date range, `deleted_at IS NULL`, in the tenant.
  - **Rep:** `COALESCE(promoted_by, claimed_by, created_by)`. Promote keeps `claimed_by`, so claimed-then-promoted work credits the person who promoted it, else the claimer, else the creator.
  - **Added per rep:** cohort count grouped by `created_by`. **Added per source:** cohort count grouped by `source_tag`.
  - **Conversion %:** promoted ÷ cohort, where promoted means `promoted_deal_id IS NOT NULL`, at any time up to now. Shown as a percentage with one decimal, as "—" when the cohort is 0. It is broken down three ways:
    - by `source_tag`;
    - by cluster tag (`unnest(cluster_tags)`; a prospect with several tags counts in each; prospects with no tags go under "(no tag)");
    - by rep (the Rep definition).
  - **Average days in each stage:** for every `prospect_stage_history` row of a cohort prospect, the time in `to_stage` runs until the next history row for that prospect. For the last row it runs until `promoted_at` (if promoted), else until now. Average per stage over all such intervals, in days with one decimal. Parked is included.
  - **Stale:** non-promoted, non-deleted, not parked, and `last_activity_at < now − (auto_park_days / 2) days`, using the tenant's `prospect_auto_park_days` (via `getProspectSettings`). This is a current snapshot, not range-bound. **Auto-parked in range** is also shown: history rows with `to_stage = 'parked'` and `changed_by = 'system:auto-park'` whose `changed_at` is in the range.
  - **Owner-scope filtering for managers:** "added per rep" filters on `created_by` in scope; conversion and days use the Rep definition in scope; stale filters on `COALESCE(claimed_by, created_by)` in scope.
- Names: user ids resolve to display names the way other reports do. Unknown or removed users show as "Former member".
- CSV: one CSV with a `section` column (`added_by_rep`, `added_by_source`, `conversion_by_source`, `conversion_by_tag`, `conversion_by_rep`, `days_in_stage`, `stale`), following the module's existing CSV helpers.

## Review Focus

1. **Scope leak:** a manager must not see counts or names for users outside their team, in any section (including the stale and auto-parked counts). Test in Task 1.
2. **Divide-by-zero and empty data:** an empty range, a source with zero cohort, or a tenant with no history must produce "—" or zeros, never NaN or a crash. Test in Task 1.
3. **Days-in-stage correctness:** the last interval ends at `promoted_at` for promoted prospects (not now), and intervals never go negative. Test with fixed timestamps in Task 1.
4. **Cluster tags with duplicates or case differences** are already normalized lower-case on save, so a prospect counts once per distinct tag. Test in Task 1.

---

### Task 1: Report query (runner)

**Files:**
- Create: `src/lib/reports/queries/prospect-board.ts`, `scripts/selftest-prospect-report-db.ts`
- Modify: `package.json` (add the selftest to `selftest`, plus `selftest:prospect-report-db`)

**Interfaces:**
- Produces:
  - `type ProspectBoardReport`:
    ```
    {
      range: { from: string; to: string };
      addedByRep: { userId: string; name: string; count: number }[];
      addedBySource: { sourceTag: string; count: number }[];
      conversionBySource: { key: string; cohort: number; promoted: number; rate: number | null }[];
      conversionByTag: { key: string; cohort: number; promoted: number; rate: number | null }[];
      conversionByRep: { userId: string; name: string; cohort: number; promoted: number; rate: number | null }[];
      daysInStage: { stage: ProspectStage; avgDays: number | null; intervals: number }[];
      stale: { count: number; thresholdDays: number; autoParkedInRange: number };
    }
    ```
    `rate` is a 0–1 fraction or null. All five stages appear in `daysInStage` in board order, even with no intervals.
  - `prospectBoardRunner`: follow the exact runner signature and filter type the other runners in `src/lib/reports/queries/` use (read `rep-performance.ts` and `stale-deals.ts`, and `ReportRunner` in `src/lib/reports/types.ts`). It supports the date range and owner scope, and returns the report plus CSV rows in the shape the module expects.
- [ ] **Step 1: Failing DB selftest.** Use two throwaway tenants (like the other DB selftests), a manager with one report, a rep outside the team, and fixed timestamps.
  - `added: per rep and per source counts`
  - `conversion: by source with one promoted of three → 33.3%`
  - `conversion: by tag counts a two-tag prospect in both, "(no tag)" bucket`
  - `conversion: by rep uses promoted_by > claimed_by > created_by`
  - `days: dump 2.0, researching 3.0 for a prospect moved at t0+2d, t0+5d, promoted at t0+6d → qualified 1.0`
  - `days: stage with no intervals → null`
  - `stale: counts prospect idle 30d with auto_park_days 45 (threshold 22), excludes promoted/parked`
  - `stale: autoParkedInRange counts system:auto-park history in range only`
  - `empty range → zero counts, null rates, no NaN`
  - `manager scope: out-of-team rep's prospects absent from every section and from stale count`
  - `owner sees all`
  - `cross-tenant data never included`
- [ ] **Step 2: Run** `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospect-report-db.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Prefer a few aggregate SQL queries per section. Use one window-function query (`LEAD(changed_at) OVER (PARTITION BY prospect_id ORDER BY changed_at)`) for days-in-stage. Run inside `tenantTransaction` with explicit `tenant_id` predicates.
- [ ] **Step 4: Run** the selftest and `pnpm exec tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(prospects): prospect board report query`.

### Task 2: Report registration, section UI, access, board link

**Files:**
- Create: `src/app/dashboard/reports/_components/prospect-board-section.tsx`
- Modify:
  - `src/lib/reports/registry.ts`: the `'prospect-board'` entry. Title "Prospect board". Description "Prospects added, prospect → lead conversion by source, tag and rep, days in each stage, and stale prospects." Category: an existing one that fits (e.g. `'performance'`); `chart: 'table-only'`; `supportsCsv: true`, `supportsDateRange: true`, `supportsOwnerScope: true`.
  - `src/app/dashboard/reports/[reportId]/page.tsx` and/or the reports index: render the new section; gate on `viewProspectReports`. If the module has no per-report permission hook, add an optional `requiresPermission?: Permission` to `ReportRegistrationBase` and enforce it on both the index listing and the detail page and CSV route. Mirror how `requiresFlag` is enforced.
  - The CSV download path: the CSV route or action already used by `csv-download-button.tsx`, so it respects the same permission.
  - `src/app/dashboard/prospects/_components/prospect-board.tsx`: a "Report" link button to `/dashboard/reports/prospect-board`, shown only with `can(role,'viewProspectReports')`.
- Section layout: four blocks, each a compact table.
  - **Added:** two side-by-side tables, by rep and by source.
  - **Conversion:** three tables, by source / tag / rep, with columns Cohort, Promoted, Rate.
  - **Days in stage:** one row per stage, with Avg days and Intervals.
  - **Stale:** "N prospects idle more than T days" plus "M auto-parked in this period".
  - An empty state per block: "No prospects in this period."
- [ ] **Step 1: Implement** per the above, mirroring an existing table-only section (e.g. `stale-deals-section.tsx`) for styling and the filter bar.
- [ ] **Step 2: Verify.** Run `pnpm exec tsc --noEmit` and eslint on touched files. The controller does a render check as owner (sees the report and the CSV), manager (team-scoped), and rep/viewer (no access, no board link).
- [ ] **Step 3: Commit** `feat(prospects): prospect board report page`.

### Task 3: README and final verification

**Files:**
- Modify: `README.md` (a new "Prospect Board" section)

- [ ] **Step 1: Write the README section.** Audience: the developer/ops person who deploys and runs Saleinx. Keep it under ~120 lines. Cover:
  - **What it is:** the pre-lead staging board. Stages: dump, researching, qualified, ready, parked.
  - **Where:** `/dashboard/prospects`, Quick Dump at `/dashboard/prospects/import`, the report at `/dashboard/reports/prospect-board`, and settings at `/dashboard/settings/prospects`.
  - **Permissions:** a role table.
  - **Promote rules:**
    - a strong match blocks, a similar name only warns;
    - merge options;
    - "Create anyway" for managers;
    - claimer ownership and distribution.
  - **Claims:** 14-day default and the settings.
  - **Jobs:**
    - `prospects-daily-maintenance` (cron `30 20 * * *` UTC = 02:00 IST): auto-park and claim expiry;
    - `prospect-enrich` (on `crm/prospect.created`).
    - Both are registered in `src/app/api/inngest/route.ts`.
  - **AI:**
    - Quick Dump parse: model env `PROSPECT_PARSE_MODEL`, default `claude-opus-5-5`.
    - Enrichment: env `PROSPECT_ENRICH_MODEL`, default `claude-haiku-5-5`; it doesn't support server-side fallback, so the code omits it for Haiku.
    - Both need `ANTHROPIC_API_KEY`.
    - Enrichment also needs AI suggestions plus the prospect enrichment setting on, and is off by default.
    - Rough cost: about ₹0.03 per prospect on Haiku 5.5.
  - **Storage:** create a **private** Supabase bucket `prospect-imports` (or set `SUPABASE_PROSPECT_IMPORTS_BUCKET`); never public.
  - **Limits:** text 60k chars, CSV 4 MB, images 5 MB (downscaled in the browser), 500 rows per import.
  - **Hosting:** `maxDuration = 300` on `/dashboard/prospects` and the import route; this needs a Vercel plan that allows it.
  - **Migration:** `0079_prospect_board.sql` via `scripts/apply-0079.ts` in the build chain. Note its replay-safe CHECK guard: any future widening must keep it.
  - **Seed:** `pnpm seed:prospects -- --tenant <slug> [--reset]`, test DB only, never calls Claude.
  - **Tests:** the prospect selftests, run with the API key blanked.
  - **Known limits:**
    - no prospect delete yet;
    - the `pnpm selftest` chain stops at the pre-existing `selftest-forecast` failure.
- [ ] **Step 2: Full verification** (key blanked in the shell: `ANTHROPIC_API_KEY= `):
  - `pnpm exec tsc --noEmit`;
  - eslint on `src/app/dashboard/prospects`, `src/lib/prospects`, `src/lib/reports`, `src/app/dashboard/reports`;
  - selftests: prospects, prospects-db, prospect-import, prospect-enrich, prospect-report-db, dedup, ai-suggestions, ai-suggestions-db, lead-capture, workflows, reports (`scripts/selftest-reports.ts`), all passing;
  - `pnpm seed:prospects -- --tenant test-1 --reset` stable.
- [ ] **Step 3: Commit** `docs(prospects): README section for the Prospect Board`.
