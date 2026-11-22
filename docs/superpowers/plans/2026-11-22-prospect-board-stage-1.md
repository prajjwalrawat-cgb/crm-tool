# Prospect Board, Stage 1 (Board) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the whole Prospect Board data model plus a usable kanban board: manual create, drawer edit, drag/bulk stage moves, group-by, filters, and seed data.

**Architecture:** Migration 0079 creates every table and column the full design needs (later stages add code, not schema). Pure rules live in `src/lib/prospects/rules.ts`; DB reads/writes in `queries.ts` / `mutations.ts` under `tenantTransaction`; server actions in `src/app/dashboard/prospects/actions.ts`; the board copies the deals board's `@dnd-kit` pattern (`src/app/dashboard/deals/board/_components/board-view.tsx`).

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before route/page code), Drizzle, Postgres RLS, `@dnd-kit/core`, zod, tsx selftests.

**Spec:** `docs/superpowers/specs/2026-11-22-prospect-board-design.md`

## Global Constraints

- Tests and seeds run only against the Docker test DB (`crm-test-pg`, port 15434, via `.env.local`). Never the `.env` (production) DB.
- Every new table: `tenant_id` FK cascade, ENABLE + FORCE RLS, the four tenant policies, grant `app_user`, revoke anon/authenticated (copy the DO-block from `drizzle/0077_ai_suggestions.sql`).
- Migration is idempotent and replayable (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before re-adding CHECKs).
- Stages exactly: `dump | researching | qualified | ready | parked`. Size bands exactly: `1-10 | 11-50 | 51-200 | 201-1000 | 1000+`.
- Settings defaults: claim days 14, claim expiry enabled true, auto-park days 45, auto-park enabled true, enrichment enabled false.
- "Rep" = `member`; "manager" check = owner/admin/manager.
- A promoted (`promoted_deal_id IS NOT NULL`) or deleted prospect is read-only.
- Claim lock: only the claimer or a manager can move stage / park / promote a claimed prospect; anyone with `manageProspects` can edit fields.
- Do not widen the TypeScript `SuggestionField` / `Appliers` types in this stage (that forces appliers for new fields; Stage 3). The SQL CHECKs are widened now.

## Review Focus

1. **Two people drag the same card at once.** History must chain correctly: lock the row `FOR UPDATE`, take `from_stage` from the locked row, no-op when already in the target stage. Test in Task 3.
2. **A prospect id from another tenant (or a deleted/promoted one) reaches an action.** Must return "not found" / "read-only", never write. Test in Task 3.
3. **Bulk move including claimed-by-someone-else, promoted, or deleted cards.** The rest still move; each skipped card is returned with a reason. Test in Task 3.
4. **Blank or messy input:** whitespace-only company name rejected; cluster tags trimmed, lower-cased, de-duplicated, max 20 × 40 chars; empty strings stored as NULL; phone/email normalized or NULL. Test in Task 2.
5. **Group-by on a null value** (no industry/territory/offering/source) lands in a "None" lane, never dropped. Test in Task 2.

---

### Task 1: Migration 0079 and Drizzle schema

**Files:**
- Create: `drizzle/0079_prospect_board.sql`, `scripts/apply-0079.ts`, `src/db/schema/prospects.ts`, `scripts/selftest-prospects-db.ts`
- Modify: `src/db/schema/index.ts` (export), `src/db/schema/deals.ts` (`sourceProspectId`), `src/db/schema/organization-settings.ts` (5 columns), `src/lib/lead-capture/constants.ts` (`LEAD_SOURCE_TYPES` += `'prospect_board'`), `package.json` (`build` chain gets `tsx scripts/apply-0079.ts` before `next build`; `selftest` script and `selftest:prospects-db` entry)

**Interfaces:**
- Produces (Drizzle, from `@/db/schema`): `prospectStage` pgEnum; tables `prospects`, `prospectStageHistory`, `prospectVotes`, `prospectImports`; types `Prospect = typeof prospects.$inferSelect`, `ProspectStage`.
- `deals.sourceProspectId`; `organizationSettings.prospectClaimDays`, `prospectClaimExpiryEnabled`, `prospectAutoParkDays`, `prospectAutoParkEnabled`, `prospectEnrichmentEnabled`.

- [ ] **Step 1: Write the failing DB selftest (schema section)** in `scripts/selftest-prospects-db.ts`, structured like `scripts/selftest-ai-suggestions-db.ts` (`check(name, ok, detail)`, two throwaway tenants created via `runWithSystemContext`, deleted at the end). Checks:
  - `schema: prospect insert defaults` → inserted row has `stage === 'dump'`, `clusterTags` deep-equals `[]`.
  - `schema: size_band CHECK` → insert with `sizeBand: '50-100'` throws.
  - `schema: icp_score CHECK` → `icpScore: 101` throws.
  - `schema: RLS isolation` → tenant B context selecting tenant A's prospect id returns 0 rows.
  - `schema: vote PK` → second identical `(prospect, user, kind)` insert throws.
  - `schema: ai_suggestions accepts prospect` → insert with `entityType 'prospect'`, `field 'icp_score'`, `sourceType 'enrichment'` succeeds.
  - `schema: lead_sources accepts prospect_board` → insert `type 'prospect_board'` succeeds.
  - `schema: deals.source_prospect_id set null on prospect hard delete`.
- [ ] **Step 2: Run it to verify it fails**
  Run: `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospects-db.ts`
  Expected: fails (import errors / relation "prospects" does not exist).
- [ ] **Step 3: Write `drizzle/0079_prospect_board.sql`** with the tables, columns, indexes and CHECKs exactly as in the spec's "Data model" section, including: unique `(tenant_id, promoted_deal_id) WHERE promoted_deal_id IS NOT NULL`; GIN `gin_trgm_ops` on `prospects.normalized_name` (as in `0053_dedup_guardrails.sql`); partial index `(tenant_id, stage) WHERE deleted_at IS NULL`; `(tenant_id, last_activity_at)`; `parked_reason IN ('stale','manual')`; `ai_suggestions` / `ai_suggestion_sources` CHECKs dropped and re-added with the widened lists; `lead_sources_type_check` re-added with `prospect_board`; `deals.source_prospect_id` + index. `prospect_imports` is created before `prospects` (FK order).
- [ ] **Step 4: Write `scripts/apply-0079.ts`** as a copy of `scripts/apply-0078.ts` with file `0079_prospect_board.sql`, hash `manual-0079-prospect-board`, `created_at` 1795219200000. Run it: `pnpm exec tsx scripts/apply-0079.ts` → `done.`; run again → every statement `ok` or `already exists, skipping`.
- [ ] **Step 5: Write the Drizzle schema** in `src/db/schema/prospects.ts` mirroring the SQL (camelCase props, `text('...').array()` for `cluster_tags`), and the column additions in the modified schema files.
- [ ] **Step 6: Run the selftest** (Step 2 command). Expected: all `schema:` checks PASS.
- [ ] **Step 7: Typecheck** `pnpm exec tsc --noEmit` → no errors.
- [ ] **Step 8: Commit** `feat(prospects): migration 0079 and schema`.

### Task 2: Rules module and permissions

**Files:**
- Create: `src/lib/prospects/rules.ts`, `scripts/selftest-prospects.ts`
- Modify: `src/lib/rbac.ts` (permissions + `can*` helpers), `package.json` (add to `selftest`)

**Interfaces:**
- Produces from `rules.ts` (no `server-only`; client-safe):
  - `PROSPECT_STAGES: readonly ['dump','researching','qualified','ready','parked']`, `SIZE_BANDS`, `GROUP_BY_KEYS: readonly ['industry','territory','product_fit','source_tag']`, `type GroupByKey`.
  - `prospectInputSchema` (zod): `companyName` (trim, 1–200), `domain`, `contactName`, `contactDesignation`, `contactEmail`, `contactPhone`, `industry`, `sizeBand`, `city`, `state`, `productFitOfferingId` (uuid), `icpScore` (int 0–100), `clusterTags`, `sourceTag` (trim, 1–80), `notes` (≤5000). All optional fields nullable; `''` → `null`.
  - `normalizeProspectInput(input: ProspectInput): ProspectRowValues`, which adds `normalizedName` (`normalizeCompanyName`), `emailNormalized` (`normalizeEmail` from `lead-capture/normalize`), `phoneNormalized` (`normalizePhone`), `domain` lower-cased without scheme/`www.`/path, and cleaned `clusterTags`.
  - `type Actor = { userId: string; role: MembershipRole }`
  - `isManagerRole(role): boolean`
  - `stageMoveBlock(p: Pick<Prospect,'claimedBy'|'promotedDealId'|'deletedAt'|'stage'>, to: ProspectStage, actor: Actor): null | 'promoted' | 'deleted' | 'claimed_by_other' | 'same_stage' | 'no_permission'`
  - `editBlock(p, actor): null | 'promoted' | 'deleted' | 'no_permission'`
  - `type ProspectFilters = { mine?: boolean; unclaimed?: boolean; source?: string; stage?: ProspectStage; q?: string; showPromoted?: boolean; groupBy?: GroupByKey }`
  - `parseProspectFilters(sp: Record<string, string | string[] | undefined>): ProspectFilters`, which ignores unknown values.
  - `groupKeyOf(card: ProspectCard, by: GroupByKey): { key: string; label: string }`, with null giving `{ key: '__none', label: 'None' }`. Territory is `state`, then `state · city`.
- `rbac.ts`: `manageProspects` [owner, admin, manager, member], `claimProspects` [owner, admin, manager, member], `promoteProspects` [owner, admin, manager, member], `manageProspectClaims` [owner, admin, manager], `bulkParkProspects` [owner, admin, manager], `viewProspectReports` [owner, admin, manager].

- [ ] **Step 1: Write the failing pure selftest** `scripts/selftest-prospects.ts` (same `check` harness, no DB). Checks:
  - `input: blank company rejected` → `prospectInputSchema.safeParse({companyName:'   ', sourceTag:'x'}).success === false`.
  - `input: tags cleaned` → `[' SaaS','saas','Pune ', '']` gives `['saas','pune']`; 25 tags are capped at 20; a 60-char tag is rejected.
  - `input: empty strings → null` for `contactEmail: ''`.
  - `normalize: phone` → `'098765 43210'` gives `'+919876543210'`; `normalize: domain` → `'https://www.Acme.com/about'` gives `'acme.com'`; `normalize: name` → `'Acme Pvt Ltd'` gives `'acme'`.
  - `move: member moves own claimed card` → `null`; `member moves other's claimed` → `'claimed_by_other'`; `manager moves other's claimed` → `null`; `promoted` → `'promoted'`; `viewer` → `'no_permission'`; `same stage` → `'same_stage'`.
  - `edit: member edits other's claimed card` → `null` (claim does not lock fields).
  - `filters: junk ignored` → `parseProspectFilters({stage:'won', groupBy:'x', mine:'1'})` deep-equals `{ mine: true }`.
  - `group: null industry → None lane`; `group: territory` with `{state:'MH', city:'Pune'}` gives label `'MH · Pune'`.
  - `rbac: matrix` → `can('viewer','manageProspects') === false`, `can('member','manageProspectClaims') === false`, `can('manager','bulkParkProspects') === true`.
- [ ] **Step 2: Run** `pnpm exec tsx scripts/selftest-prospects.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `rules.ts` and the rbac entries** per the Interfaces block.
- [ ] **Step 4: Run** the Step 2 command. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(prospects): input rules, stage-move guard, permissions`.

### Task 3: Queries and mutations

**Files:**
- Create: `src/lib/prospects/queries.ts`, `src/lib/prospects/mutations.ts` (both `import 'server-only'`)
- Modify: `scripts/selftest-prospects-db.ts` (add sections)

**Interfaces:**
- Consumes: Task 2 rules; `tenantTransaction` from `@/lib/db-context`.
- Produces:
  - `type ProspectCard = { id; companyName; contactName; contactEmail; sourceTag; clusterTags: string[]; industry; city; state; sizeBand; productFitOfferingId; productFitName: string | null; icpScore; stage; claimedBy; claimExpiresAt; votesKnowSomeone: number; votesPriority: number; promotedDealId; lastActivityAt }`
  - `listProspectsForBoard(tenantId: string, viewerId: string, f: ProspectFilters): Promise<ProspectCard[]>`. `mine` means `claimed_by = viewer OR created_by = viewer`; `unclaimed` means `claimed_by IS NULL`; promoted rows are hidden unless `showPromoted`; deleted rows are always hidden; `q` is an ILIKE on company/contact. Limit 1000, ordered by `last_activity_at desc`.
  - `getProspect(tenantId: string, id: string): Promise<Prospect | null>`
  - `listSourceTags(tenantId: string): Promise<string[]>`
  - `createProspect(tenantId: string, actor: Actor, input: ProspectInput): Promise<{ ok: true; id: string } | { ok: false; error: string }>`, which inserts plus a history row (`from_stage` null, `to_stage` 'dump').
  - `updateProspect(tenantId, actor, id, input: Partial<ProspectInput>): Promise<MutationResult>`, which guards with `editBlock`, re-normalizes, and bumps `last_activity_at`/`updated_at`.
  - `moveProspectStage(tenantId, actor, id, to: ProspectStage): Promise<MutationResult>`. It runs `SELECT … FOR UPDATE`, applies `stageMoveBlock` (`same_stage` counts as ok with no write), sets `stage`, `stage_changed_at`, and `parked_reason = to === 'parked' ? 'manual' : null`, bumps activity, and inserts a history row with `changed_by = actor.userId`.
  - `bulkMoveStage(tenantId, actor, ids: string[], to): Promise<{ moved: string[]; skipped: { id: string; reason: string }[] }>`, which runs one transaction per id via `moveProspectStage`. Max 500 ids. `to === 'parked'` with more than one id requires `bulkParkProspects`.
  - `type MutationResult = { ok: true } | { ok: false; error: 'not_found' | 'promoted' | 'deleted' | 'claimed_by_other' | 'no_permission' | 'invalid'; message: string }`

- [ ] **Step 1: Add failing DB checks** to `scripts/selftest-prospects-db.ts`:
  - `create: history row` → after `createProspect`, the history has exactly one row `{from_stage:null,to_stage:'dump'}`.
  - `move: chains history` → dump to researching to qualified gives 3 rows, each `from_stage` equal to the previous `to_stage`.
  - `move: concurrent` → `Promise.all` of two `moveProspectStage(...,'ready')` calls gives a final stage of `ready` and exactly one history row with `to_stage 'ready'`.
  - `move: park sets reason` → `parked_reason === 'manual'`; moving it out sets `null`.
  - `move: cross-tenant id` → tenant B actor moving A's id gives `error 'not_found'`, and A's row is unchanged.
  - `move/edit: promoted read-only` → set `promoted_deal_id` directly, then both return `'promoted'`.
  - `bulk: mixed` → 3 ids (one claimed by another member, one deleted, one fine) moved by a member give `moved.length === 1` and `skipped` reasons `['claimed_by_other','deleted']`.
  - `bulk: park needs manager` → a member bulk-parking 2 ids gets every id skipped with `'no_permission'`.
  - `list: filters` → `mine`, `unclaimed`, `source`, `stage` each return the expected ids; promoted rows are hidden by default.
  - `list: vote counts` → 2 `priority` votes and 1 `know_someone` vote show on the card.
- [ ] **Step 2: Run** `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospects-db.ts`. Expected: new checks FAIL.
- [ ] **Step 3: Implement `queries.ts` and `mutations.ts`.** Vote counts come from `count(*) FILTER (WHERE kind = …)` in a left-joined subquery; `productFitName` comes from a left join to `offerings`.
- [ ] **Step 4: Run** the Step 2 command. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(prospects): board queries and stage mutations`.

### Task 4: Server actions, board page, and nav

**Files:**
- Create: `src/app/dashboard/prospects/actions.ts`, `src/app/dashboard/prospects/page.tsx`, `loading.tsx`, `error.tsx` (copy the deals board's), `src/app/dashboard/prospects/_components/{prospect-board.tsx, prospect-column.tsx, prospect-card.tsx, board-toolbar.tsx, bulk-bar.tsx}`
- Modify: `src/app/dashboard/_components/nav-config.ts` (add `{ href: '/dashboard/prospects', label: 'Prospect board', icon: ClipboardList }` above "Pipeline" in every persona's Sales group that lists Pipeline)

**Interfaces:**
- Consumes: Task 3.
- Produces (actions, `'use server'`, same `ActionResult` shape as `src/app/dashboard/leads/actions.ts`, gated with `checkPermission('manageProspects')` and run inside `runWithTenantContext`):
  - `createProspectAction(input: unknown): Promise<ActionResult<{ id: string }>>`
  - `updateProspectAction(id: string, input: unknown): Promise<ActionResult>`
  - `moveProspectStageAction(id: string, to: string): Promise<ActionResult>`
  - `bulkMoveStageAction(ids: string[], to: string): Promise<ActionResult<{ moved: number; skipped: { id: string; reason: string }[] }>>`
  - Each calls `revalidatePath('/dashboard/prospects')`.

- [ ] **Step 1: Implement the actions.** Map `MutationResult` errors to user copy: `claimed_by_other` gives "Claimed by someone else. Only they or a manager can move it." and `promoted` gives "Already promoted to a lead."
- [ ] **Step 2: Implement `page.tsx`.** It uses `withTenantSession` and `parseProspectFilters(await searchParams)`, then in parallel `listProspectsForBoard`, `listSourceTags`, `listTeammates`, and the active offerings. It renders `<ProspectBoard>`.
- [ ] **Step 3: Implement the board.**
  - Columns are `PROSPECT_STAGES`, with `parked` collapsed by default (as in `collapsed-hold-column.tsx`).
  - With `groupBy` set, render swimlanes: one row of stage columns per `groupKeyOf` lane, lanes sorted by label, "None" last.
  - Drag-end applies an optimistic move, then calls `moveProspectStageAction`; on `ok:false` it reverts and shows a toast with the message.
  - Cards show the spec's card fields: claim avatar plus "Nd left" from `claimExpiresAt`, and ICP as a number badge.
  - Toolbar: Mine, Unclaimed, Source select, Stage select, Group-by select, search, and "Show promoted". All of them write the URL query string (`router.replace`).
  - Bulk: a checkbox on each card; a sticky `bulk-bar` with "Move to…" and "Park" (Park hidden unless `can(role,'bulkParkProspects')`) shows "Moved N, skipped M" with reasons in an expandable list.
  - Viewers get no drag handles or checkboxes.
- [ ] **Step 4: Verify.** Run `pnpm exec tsc --noEmit` and `pnpm lint`; expect no new errors. Run `pnpm dev`, open `/dashboard/prospects` as a member, drag a seeded card (after Task 6, or one created in Task 5) between columns, refresh, and confirm it stayed. Switch Group-by to industry and check that a "None" lane appears.
- [ ] **Step 5: Commit** `feat(prospects): board page, drag and bulk stage moves`.

### Task 5: Create dialog and card drawer

**Files:**
- Create: `src/app/dashboard/prospects/_components/{prospect-form.tsx, prospect-drawer.tsx, new-prospect-button.tsx}`
- Modify: `prospect-board.tsx` (open the drawer on card click; `?p=<id>` in the URL so it is linkable), `page.tsx` (when `p` is set, `getProspect` and pass it in)

**Interfaces:**
- Consumes: `createProspectAction`, `updateProspectAction`, `prospectInputSchema` (client-side validation with `react-hook-form` + `@hookform/resolvers/zod`, as other forms do).

- [ ] **Step 1: Build `prospect-form.tsx`**: every `prospectInputSchema` field, with Size band and Product fit (active offerings) as selects, tags as comma-separated input, and Source tag as a combobox over `listSourceTags` that also accepts new values.
- [ ] **Step 2: Build the drawer** with the form in edit mode, plus read-only meta (created by/at, stage history list, claim status). Promoted prospects render read-only with "Open lead →" linking `/dashboard/deals/<promotedDealId>`. Placeholders for Comments / Votes / Claim are left out (Stage 2 adds them).
- [ ] **Step 3: "New prospect"** button in the toolbar (hidden without `manageProspects`) opens the form in create mode, and the new card appears in Dump.
- [ ] **Step 4: Verify.** Run `pnpm exec tsc --noEmit` and `pnpm lint`. Then in the browser:
  - create a prospect with a blank company: the inline error shows;
  - create a valid one: the card appears in Dump;
  - edit its industry in the drawer: the card updates;
  - open `?p=<id>` directly: the drawer opens.
- [ ] **Step 5: Commit** `feat(prospects): create dialog and edit drawer`.

### Task 6: Seed data

**Files:**
- Create: `scripts/seed-prospects.ts`
- Modify: `package.json` (`"seed:prospects": "tsx --require ./scripts/_shim-server-only.cjs scripts/seed-prospects.ts"`)

**Interfaces:**
- Consumes: `createProspect`, `moveProspectStage` (so history is real), direct inserts for votes and claims.

- [ ] **Step 1: Write the seed.**
  - Args: `--tenant <slug-or-id>` (required) and `--reset`, which deletes that tenant's prospects whose `source_tag` is one of the three below.
  - It refuses to run unless `DATABASE_URL` contains `:15434`, or `SEED_ALLOW_REMOTE=1` is set. It prints which host it is using.
  - Data: 30 prospects with plausible Indian B2B companies and 10 per source tag (`Trade show 2026`, `LinkedIn`, `Referral`).
  - Spread: stages 10 dump / 8 researching / 6 qualified / 4 ready / 2 parked. Mixed industries, size bands, states and cities, with a few leaving industry or state null.
  - About 8 are claimed by the tenant's members, with `claim_expires_at` set to now + 14 days; about 12 have votes.
  - Product fit uses the tenant's active offerings when it has any.
  - Promoted examples are added in Stage 3.
- [ ] **Step 2: Run** `pnpm seed:prospects -- --tenant <test tenant>` twice with `--reset`. Expected: 30 rows each time, not 60. Count history rows: at least 30.
- [ ] **Step 3: Verify** that the board shows 30 cards across 3 sources, and that the Source filter and Group-by "source_tag" each show 3 lanes.
- [ ] **Step 4: Commit** `feat(prospects): seed 30 prospects across 3 sources`.

### Task 7: Full verification

- [ ] **Step 1:** `pnpm exec tsc --noEmit` and `pnpm lint` both pass, with no new warnings in the touched files.
- [ ] **Step 2:** `pnpm selftest` passes overall, including both prospect selftests.
- [ ] **Step 3:** Replay the migration (`pnpm exec tsx scripts/apply-0079.ts`) on the test DB; it is idempotent.
- [ ] **Step 4:** As a viewer user, the board is read-only: no drag, no checkboxes, no New button, and calling an action returns a permission error.
