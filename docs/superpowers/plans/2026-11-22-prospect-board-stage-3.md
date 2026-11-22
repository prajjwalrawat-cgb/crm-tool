# Prospect Board, Stage 3 (Promote, daily jobs, AI enrichment) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a researched prospect into a Lead (single and bulk) through the existing duplicate checks and lead routing. Keep the board tidy with a daily job that auto-parks stale prospects and releases expired claims. Have Claude propose industry / size band / product fit / ICP score into the existing AI suggestions queue for a human to accept or reject.

**Architecture:** There is no new migration: 0079 already has `deals.source_prospect_id`, the prospect promotion columns, the `organization_settings.prospect_*` columns, the widened `ai_suggestions` CHECKs and the `prospect_board` lead-source type. The work is split across:
- `src/lib/prospects/promote/` (match finding, the transactional create, routing after commit);
- `src/lib/prospects/maintenance.ts` (daily job logic);
- `src/lib/prospects/enrich.ts` (Claude call into `persistSuggestions`);
- two Inngest functions in `src/lib/inngest/workflows/prospects.ts`;
- a settings page at `/dashboard/settings/prospects`;
- prospect support in the AI suggestions service and appliers.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before page/action code), Drizzle, Postgres RLS, Inngest v4 (`cron` triggers, `sendWorkflowEvent`), `@anthropic-ai/sdk` 0.94 (streamed, plain `json_schema` structured output, read ourselves like `src/lib/prospects/import/parse.ts`), tsx selftests.

**Spec:** `docs/superpowers/specs/2026-11-22-prospect-board-design.md`: sections "Promote", "Inngest jobs", "Permissions", "Activity", and the `ai_suggestions` / `lead_sources` notes under "Changes to existing tables". The user decided on 2026-11-22: strong matches block and fuzzy ones warn; merge creates the new lead on the picked company/contact or links to the open lead; a claimed prospect's lead goes to the claimer.

## Global Constraints

- Tests and seeds run only against the Docker test DB (`crm-test-pg`, port 15434, via `.env.local`). Never the `.env` (production) DB. No new migration. No real Claude calls in tests (no `ANTHROPIC_API_KEY`); stub them like `scripts/selftest-prospect-import.ts`.
- **Promote preconditions:**
  - Allowed only when not promoted, not deleted and not parked ("Unpark it first.").
  - The prospect needs a company name plus a contact email or phone ("Add an email or phone before promoting.").
  - The caller needs `promoteProspects`.
  - A prospect claimed by someone else needs the caller to be a manager (`manageProspectClaims`, within their `scopeUsers` team) or owner/admin.
- **Promote match rules:**
  - **Strong (blocks):** exact normalized company name (`findCompanyMatches` `kind: 'exact'`); company domain (`findCompanyByDomain`); contact email (`findContactByEmail`); contact phone (`findContactByPhone`); an open lead (`deals.stage = 'lead'`, not deleted) whose `company_id` is a strong-matched company or whose `company_name_text` normalizes to the same name.
  - **Weak (warns):** fuzzy / first-word company matches (`kind: 'fuzzy'`).
  - **Merge:** the user picks one candidate. Picking an open lead links the prospect to it (`promoted_deal_id`), copies notes and comments, creates no new lead and does no routing. Picking a company and/or contact creates the new lead under them instead of creating new ones.
  - **Create anyway:** managers and owner/admin only (`manageProspectClaims` or `can(role,'manageDeals')` with role ≠ member); sets `dedup_override = true` on any company it creates.
- **Created lead:**
  - Fields: `deals.stage = 'lead'`, `source = 'Prospect Board: <source_tag>'`, `lead_source_id` = the tenant's Prospect Board lead source, `company_id`, `company_name_text`, `lead_city`, `lead_state`, `lead_product_interest` = the offering name (null if none), `source_prospect_id`.
  - Notes: prospect notes are copied into `notes` as one note; each prospect comment becomes a note whose body starts "Comment by <name> on <date>:".
  - Activity: one `recordActivity` on the deal, "Promoted from Prospect Board".
  - Prospect: `promoted_deal_id`, `promoted_at`, `promoted_by` are set in the same transaction.
- **Ownership:**
  - Claimed (active claim) → the lead goes to the claimer via the existing `reassignLead` (`src/lib/lead-capture/sla.ts`) after commit, then `notifyAssigned`.
  - Unclaimed → `distributeLead({ tenantId, dealId })` after commit.
  - `distributeLead` itself is unchanged.
- **Prospect Board lead source:** one row per tenant, `type 'prospect_board'`, name "Prospect Board". Created lazily the way `ensureCsvImportSource` works. If an admin already created a `prospect_board` source, reuse the oldest active one.
- **Settings (per tenant, `organization_settings`):**
  - `prospect_claim_days` (1–90, default 14).
  - `prospect_claim_expiry_enabled`: when false, new claims get `claim_expires_at = null`, which never expires; existing claims keep their dates.
  - `prospect_auto_park_days` (7–365, default 45).
  - `prospect_auto_park_enabled`.
  - `prospect_enrichment_enabled`: only effective when `ai_suggestions_enabled` is also on.
  - Editable by owner/admin only (the permission the existing AI-suggestions settings page uses).
- **Daily job:**
  - Schedule: 02:00 IST = `cron('30 20 * * *')` UTC.
  - Per tenant, auto-park: every non-promoted, non-deleted, non-parked prospect with `last_activity_at < now - auto_park_days` → stage `parked`, `parked_reason 'stale'`, history `changed_by 'system:auto-park'`, `stage_changed_at` now. It does NOT bump `last_activity_at`.
  - Release: every claim with `claim_expires_at <= now` → clear the claim columns and notify the former claimer, `type 'prospect_claim_expired'`, "Your claim on <company> expired".
  - Each part respects its enabled flag. Re-running the job the same day changes nothing new.
- **Enrichment:**
  - Trigger: on event `crm/prospect.created` `{ tenantId, prospectId }`, sent after commit from manual create and from confirm-import (one event per prospect). Only runs when both flags are on and `ANTHROPIC_API_KEY` is set.
  - Claude: model `process.env.PROSPECT_ENRICH_MODEL?.trim() || 'claude-opus-5-5'`, effort `'low'`, streamed, plain `json_schema`, stop_reason checked first, read ourselves.
  - Output: per field (`industry`, `size_band`, `product_fit`, `icp_score`) a value + `reasoning` (≤ 500 chars) + `confidence` (0–1). Product fit must be one of the tenant's active offerings, sent to Claude as `{id, name}`; any other value is dropped.
  - Persisting: through `persistSuggestions` with `entity_type 'prospect'`, `source_type 'enrichment'`, `source_id` = prospect id. `evidence_quote` holds the reasoning, and the quote-in-source check is skipped for `enrichment`. `ai_suggestion_sources` is the idempotency claim.
  - Fields that already have a value on the prospect are not suggested.
  - **AI never writes a prospect field.** Only accepting a suggestion does, through `updateProspect` as the accepting user (read-only and permission rules apply).
- **Suggestion scope for prospects:** owner = `COALESCE(claimed_by, created_by)`; entity name = `company_name`; link `/dashboard/prospects?p=<id>`.
- Every action that changes a prospect bumps `last_activity_at`, except the auto-park job.

## Review Focus

1. **Two people promote the same prospect at once** (or a bulk promote overlaps a single one): exactly one lead is created; the other gets "Already promoted to a lead." Lock the prospect `FOR UPDATE` inside the promote transaction and re-check `promoted_deal_id`. Test in Task 2.
2. **Routing failure after commit** (distribution throws, or the claimer was suspended between claim and promote): the lead and promotion stay committed; the lead lands in the unassigned queue (`distributeLead` outcome or the existing unassigned path), and the user sees "Promoted — routing will retry" rather than an error. Test in Task 2.
3. **Auto-park edge cases:** never parks promoted, deleted, already-parked, or recently active prospects; a prospect someone touched after the job selected it (activity bumped in between) is not parked. Re-check the condition in the UPDATE's WHERE. Test in Task 5.
4. **Enrichment safety:** the dump/prospect text sits only in the user turn; an invented offering, an out-of-range ICP, or a size band outside the list is dropped; a prospect promoted or deleted before the job runs gets no suggestions; re-delivery of the event creates no duplicates. Test in Task 6.
5. **Accepting a suggestion on a promoted or now-claimed-by-someone-else prospect:** the edit goes through `updateProspect` (field edits are allowed on claimed prospects; promoted ones are read-only), so a promoted prospect's suggestion fails with "Already promoted to a lead." and stays pending (or is marked stale per the existing decide flow). Test in Task 7.

---

### Task 1: Promote candidate matching and preconditions

**Files:**
- Create: `src/lib/prospects/promote/match.ts` (`server-only`), `src/lib/prospects/promote/rules.ts` (pure)
- Modify: `scripts/selftest-prospects.ts`, `scripts/selftest-prospects-db.ts`

**Interfaces:**
- Produces (pure `rules.ts`):
  - `promoteBlock(p: GuardRow & { companyName: string; emailNormalized: string | null; phoneNormalized: string | null }, actor: Actor, opts: { holderInScope: boolean }, now?: Date)`, returning one of:
    - `null`
    - `'no_permission'`
    - `'deleted'`
    - `'promoted'`
    - `'parked'`
    - `'missing_contact'`
    - `'claimed_by_other'`
    - `'out_of_scope'`
  - Order: no_permission, deleted, promoted, parked, missing_contact, then claim checks. The claim checks use `isClaimActive`; owner/admin skip them; a manager needs `holderInScope`.
  - `type MatchCandidate = { kind: 'company' | 'contact' | 'open_lead'; id: string; label: string; sublabel: string | null; strength: 'strong' | 'weak'; reason: 'name' | 'domain' | 'email' | 'phone' | 'fuzzy_name' | 'open_lead' }`
- Produces (`match.ts`): `findPromoteCandidates(tenantId: string, p: Prospect): Promise<MatchCandidate[]>`, built from the Global Constraints rules. Candidates are de-duplicated by `kind+id`, keeping the strongest. Open leads get label = deal name and sublabel = owner display name or "Unassigned".

- [ ] **Step 1: Failing tests.**
  - Pure:
    - `promote: parked → 'parked'`
    - `promote: no email/phone → 'missing_contact'`
    - `promote: member on other's active claim → 'claimed_by_other'`
    - `promote: member on other's expired claim → null`
    - `promote: manager out of scope → 'out_of_scope'`
    - `promote: owner on other's claim → null`
    - `promote: viewer → 'no_permission'`
  - DB, seeding a company "Acme Steel Pvt Ltd" (domain acme.in), a contact with email `ravi@acme.in` and phone `+919845012345`, and an open lead with `company_name_text 'Kaveri Textiles'`:
    - prospect "Acme Steel" → strong company by name;
    - prospect with domain `www.acme.in` → strong by domain;
    - email match → strong contact;
    - phone `09845012345` → strong contact by phone;
    - prospect "Kaveri Textiles Ltd" → strong open_lead;
    - prospect "Acme Engineering" → weak fuzzy only;
    - a cross-tenant company with the same name → not returned;
    - a soft-deleted company → not returned.
- [ ] **Step 2: Run** `pnpm exec tsx scripts/selftest-prospects.ts` and `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospects-db.ts`. Expected: new checks FAIL.
- [ ] **Step 3: Implement**, reusing `src/lib/dedup/queries.ts` (`findCompanyMatches`, `findCompanyByDomain`, `findContactByEmail`, `findContactByPhone`) and `normalizeCompanyName`.
- [ ] **Step 4: Run** both selftests and `pnpm exec tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(prospects): promote preconditions and duplicate candidates`.

### Task 2: Promote (create lead, merge, route)

**Files:**
- Create: `src/lib/prospects/promote/promote.ts` (`server-only`), `src/lib/prospects/promote/lead-source.ts` (`server-only`)
- Modify: `src/lib/prospects/mutations.ts` (export what's needed), `scripts/selftest-prospects-db.ts`

**Interfaces:**
- Consumes: Task 1; `reassignLead` / `notifyAssigned` from `src/lib/lead-capture/sla.ts`; `distributeLead` from `src/lib/lead-capture/distribute.ts`; `recordActivity`; the `notes` table; `listCommentsForEntity`; the existing company/contact creation and normalization used by lead capture and Ask Mira (find the lib-level insert path; do not call session-bound server actions from inside the transaction).
- Produces:
  - `ensureProspectBoardSource(tx, tenantId, createdBy): Promise<string>`
  - `type PromoteChoice = { leadId?: string; companyId?: string; contactId?: string; createAnyway?: boolean; ignoreWarnings?: boolean }`
  - `type PromoteOutcome`, one of:
    - `{ status: 'promoted'; dealId: string; linked: boolean; routing: 'claimer' | 'distributed' | 'unassigned' | 'queued' | 'retry' }`
    - `{ status: 'blocked'; candidates: MatchCandidate[] }` (strong matches exist and no valid choice was given)
    - `{ status: 'warn'; candidates: MatchCandidate[] }` (only weak matches, and `ignoreWarnings` not set)
    - `{ status: 'error'; error: string; message: string }`
  - `promoteProspect(tenantId: string, actor: Actor, id: string, choice?: PromoteChoice, now?: Date): Promise<PromoteOutcome>`
  - `bulkPromote(tenantId, actor, ids: string[], opts: { ignoreWarnings?: boolean }): Promise<{ results: { id: string; outcome: PromoteOutcome }[] }>`. Per-id, sequential, malformed id → error `not_found`, >100 ids → all `invalid` (my call: bulk promote is heavier than stage moves).
- Behaviour:
  1. UUID guard, then one `tenantTransaction`.
  2. Lock the prospect `FOR UPDATE` and apply `promoteBlock` (scope via `scopeUsers` when the actor is a manager).
  3. Compute candidates (inside the transaction, reading with the tx).
  4. Choice validation: a `leadId`, `companyId` or `contactId` must be one of the returned candidates (else `invalid`). `createAnyway` requires a manager or owner/admin. Strong candidates with no choice and no `createAnyway` → `blocked`. Only weak candidates and no `ignoreWarnings` → `warn`.
  5. Link path (`leadId`): set promotion columns, copy notes and comments onto that deal, record the activity, no routing; `linked: true`.
  6. Create path: company (picked, or new with the normalized name, domain, industry, `dedup_override` when `createAnyway`), contact (picked, or new with name, designation, email, phone, normalized fields, company), deal (fields per Global Constraints, `owner_id` null), notes and comments copied, activity, promotion columns set.
  7. After commit, routing:
     - Active claim held by an active member who can claim → `reassignLead({ tenantId, dealId, toUserId: claimer, actorUserId: actor.userId, reason: 'Claimed on Prospect Board' })`, then `notifyAssigned`.
     - Otherwise → `distributeLead`, mapping its status to `distributed` / `unassigned` / `queued`.
     - A throw in routing is caught, logged with `captureError`, and returns `routing: 'retry'`. The lead is left for the existing unassigned / SLA retry path.
- [ ] **Step 1: Failing DB tests:**
  - `promote: clean prospect creates company+contact+lead with all fields` (check every Global-Constraints field, including `source_prospect_id` and `lead_product_interest`);
  - `promote: notes + comments copied as notes with the prefix`;
  - `promote: claimed → lead owner is claimer, an open lead_assignments row exists`;
  - `promote: unclaimed → distributeLead called` (assert the outcome routing is one of distributed / unassigned / queued);
  - `promote: strong match → blocked, nothing written`;
  - `promote: weak only → warn; with ignoreWarnings → promoted`;
  - `promote: choose existing company → deal.company_id = picked, no new company`;
  - `promote: choose open lead → linked, no new deal, promoted_deal_id = that lead`;
  - `promote: createAnyway by member → no_permission; by manager → promoted with dedup_override`;
  - `promote: choice not among candidates → invalid`;
  - `promote: concurrent` (Promise.all of two promotes) → exactly one `promoted`, one error `promoted`, one deal;
  - `promote: routing throws` (inject a failing distribute via an optional deps param) → `promoted` with `routing 'retry'`, deal committed;
  - `promote: lead source reused when an admin-created prospect_board source exists`;
  - `bulk: mixed` (clean, blocked, parked, malformed).
- [ ] **Step 2: Run** the DB selftest. Expected: FAIL.
- [ ] **Step 3: Implement.** Add an optional last param `deps?: { distribute?: typeof distributeLead; reassign?: typeof reassignLead }` for the failure test.
- [ ] **Step 4: Run** the DB selftest, `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-dedup.ts`, `pnpm exec tsx scripts/selftest-lead-capture.ts`, and `pnpm exec tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(prospects): promote to lead with merge and routing`.

### Task 3: Promote UI (drawer, bulk, actions)

**Files:**
- Create: `src/app/dashboard/prospects/_components/promote-dialog.tsx`
- Modify: `src/app/dashboard/prospects/actions.ts`, `prospect-drawer.tsx`, `bulk-bar.tsx`

**Interfaces:**
- Actions:
  - `promoteProspectAction(id: string, choice?: PromoteChoice): Promise<ActionResult<PromoteOutcome>>`
  - `bulkPromoteAction(ids: string[], ignoreWarnings: boolean): Promise<ActionResult<{ results: … }>>`
  - Both gated by `promoteProspects`, run in `runWithTenantContext`, and call `revalidatePath('/dashboard/prospects')` and `revalidatePath('/dashboard/deals')`.
- UI:
  - **Promote button:** a **Promote to lead** button in the drawer header area. It is hidden without `promoteProspects`, and disabled with the reason when `promoteBlock` is non-null (computed client-side from the same pure rules, with `holderInScope` passed from the page).
  - **Dialog states:** checking → blocked / warn / done.
    - **Blocked:** lists strong candidates grouped by kind, with their reason ("Same company name", "Same domain", "Same email", "Same phone", "Open lead for this company"). Radio-select one, then "Use this". Managers also get "Create anyway".
    - **Warn:** lists weak candidates with "Similar name"; "Promote anyway" (sends `ignoreWarnings`) or pick one.
    - **Done:** "Promoted. <Open lead →>" plus the routing line: "Assigned to <claimer>", "Routed by your distribution rules", "Waiting in the unassigned queue", or "Promoted — routing will retry".
  - **Bulk bar:** a "Promote" action (with `promoteProspects`), a confirm step with an "Ignore similar-name warnings" checkbox, and a result list per card. Blocked and warn rows show "Open" to open that card's dialog.
- [ ] **Step 1: Implement** per Interfaces.
- [ ] **Step 2: Verify.** Run `pnpm exec tsc --noEmit` and eslint on touched files. A browser check by the controller is required: promote a clean seeded prospect as rep, promote one matching a seeded company to see the block, then pick and promote it; bulk promote 3.
- [ ] **Step 3: Commit** `feat(prospects): promote to lead from the drawer and bulk bar`.

### Task 4: Prospect settings page and claim-expiry flag

**Files:**
- Create: `src/app/dashboard/settings/prospects/{page.tsx, actions.ts, _components/prospect-settings-form.tsx}`, `src/lib/prospects/settings.ts` (`server-only`)
- Modify: `src/lib/prospects/claims.ts` (expiry flag), the settings nav (wherever `/dashboard/settings/ai-suggestions` is listed), `scripts/selftest-prospects-db.ts`

**Interfaces:**
- `getProspectSettings(tenantId): Promise<{ claimDays: number; claimExpiryEnabled: boolean; autoParkDays: number; autoParkEnabled: boolean; enrichmentEnabled: boolean; aiSuggestionsEnabled: boolean }>`. Defaults apply when there is no `organization_settings` row.
- `updateProspectSettings(tenantId, actor, input): Promise<MutationResult>`. Zod: `claimDays` int 1–90, `autoParkDays` int 7–365. Upserts the row. The permission matches `src/app/dashboard/settings/ai-suggestions/actions.ts`.
- `claimProspect` and `reassignClaim` set `claim_expires_at = null` when `claimExpiryEnabled` is false.
- Page: five controls with one-line help each. The enrichment toggle is disabled, with the note "Turn on AI suggestions first", when `ai_suggestions_enabled` is off.
- [ ] **Step 1: Failing DB tests:** `settings: defaults with no row`; `settings: update + read back`; `settings: out of range rejected`; `settings: member denied`; `claim: expiry disabled → claim_expires_at null and claim stays active`.
- [ ] **Step 2: Run** the DB selftest. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the DB selftest and `pnpm exec tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(prospects): prospect board settings`.

### Task 5: Daily maintenance job

**Files:**
- Create: `src/lib/prospects/maintenance.ts` (`server-only`), `src/lib/inngest/workflows/prospects.ts`
- Modify: `src/lib/inngest/workflows/index.ts` (register), `src/db/schema/notifications.ts` (`NOTIFICATION_TYPES` += `'prospect_claim_expired'`), `src/app/dashboard/_components/notification-bell.tsx` (icon/colour maps), `scripts/selftest-prospects-db.ts`

**Interfaces:**
- `runProspectMaintenance(tenantId: string, now?: Date): Promise<{ parked: number; released: number }>`
  - Reads settings.
  - Auto-park: one UPDATE … WHERE (the conditions in Global Constraints, re-checked in the WHERE) RETURNING id, plus history rows.
  - Releases expired claims (RETURNING id, claimed_by, company_name), then sends best-effort notifications after commit.
  - Runs inside `runWithSystemContext(tenantId, …)` the way `hold-revisit-daily.ts` does.
- `prospectMaintenanceDaily`: Inngest function `id: 'prospects-daily-maintenance'`, `cron('30 20 * * *')`, one `step.run` per tenant, the same `runWithTrace` / `incr` / `observe` pattern as `src/lib/inngest/workflows/hold-revisit-daily.ts`. Also export the plain handler for tests.
- [ ] **Step 1: Failing DB tests (fixed `now`):**
  - `maint: parks stale` (last_activity 50 days ago → parked, reason stale, history by `system:auto-park`);
  - `maint: keeps recent` (40 days);
  - `maint: skips promoted/deleted/parked`;
  - `maint: auto-park disabled → none`;
  - `maint: custom days (10)`;
  - `maint: releases expired claim + notification row`;
  - `maint: keeps active claim`;
  - `maint: expiry disabled → no release`;
  - `maint: rerun is no-op`;
  - `maint: last_activity_at unchanged by park`.
- [ ] **Step 2: Run** the DB selftest. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the DB selftest and `pnpm exec tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(prospects): daily auto-park and claim expiry job`.

### Task 6: Enrichment (Claude → suggestions)

**Files:**
- Create: `src/lib/prospects/enrich.ts` (`server-only`), `scripts/selftest-prospect-enrich.ts` (pure, stubbed)
- Modify:
  - `src/db/schema/ai-suggestions.ts`: `SUGGESTION_FIELDS` += `industry, size_band, product_fit, icp_score`; `SUGGESTION_SOURCE_TYPES` += `enrichment`; the entity-type list += `prospect`.
  - `src/lib/ai/suggestions/validate.ts`: per-field validation for the new fields, and skipping the quote-in-source check for `enrichment`.
  - `src/lib/ai/suggestions/service.ts`: `persistSuggestions` accepts the prospect entity and the enrichment source; `readLiveValue` for prospects.
  - `src/lib/inngest/client.ts` and `events.ts`: `prospectCreatedEvent 'crm/prospect.created'`.
  - `src/lib/inngest/workflows/prospects.ts` (`prospectEnrich` function).
  - `src/app/dashboard/prospects/actions.ts` (send the event after create).
  - `src/lib/prospects/import/imports.ts` (send one event per inserted prospect after the confirm commits).
  - `src/lib/ai/suggestions/appliers.ts`: stub appliers for the four new fields, returning `{ ok:false, message:'Not available yet.' }` so the `Appliers` record type-checks. Task 7 replaces them.
  - `package.json` (selftest).

**Interfaces:**
- `buildEnrichRequest(input: { prospect: Pick<Prospect, 'companyName'|'domain'|'industry'|'sizeBand'|'city'|'state'|'contactDesignation'|'notes'|'clusterTags'|'productFitOfferingId'|'icpScore'>; offerings: { id: string; name: string }[] })`. It returns the request params. The system prompt is fixed: an ICP analyst for an Indian B2B sales team; use only the given facts and general knowledge of the company if confident; null when unsure; ICP 0–100 means fit for these offerings; reasoning ≤ 500 chars.
- `enrichProspect(tenantId: string, prospectId: string, deps?: { create?: StreamFn }): Promise<RunResult>` (reuse `RunResult` from service.ts):
  - Check flags and key.
  - Claim `ai_suggestion_sources (tenant, 'enrichment', prospectId)`; already claimed → skipped.
  - Load the prospect; promoted or deleted → skipped.
  - Call Claude and validate: product_fit id must be in the offerings, size band in SIZE_BANDS, ICP an integer 0–100, industry ≤ 80 chars.
  - Skip fields that already have a value.
  - `persistSuggestions(...)` and mark the source done.
- `prospectEnrich`: Inngest function on `crm/prospect.created`, `concurrency: { limit: 5 }`, `retries: 2`, calls `enrichProspect` inside `runWithSystemContext`.
- [ ] **Step 1: Failing tests.**
  - Pure (stubbed stream):
    - `enrich: request shape` (model default/env, effort low, plain json_schema, prospect text only in the user turn, offerings listed by id+name);
    - `enrich: invented offering dropped`;
    - `enrich: icp 120 dropped, 85 kept`;
    - `enrich: size band outside list dropped`;
    - `enrich: refusal/max_tokens → failed, no suggestions`;
    - `enrich: existing industry not suggested`.
  - DB:
    - `enrich: creates pending suggestions with entity prospect, source enrichment, evidence = reasoning`;
    - `enrich: event twice → no duplicates`;
    - `enrich: flags off → skipped`;
    - `enrich: promoted prospect → skipped`;
    - `enrich: never writes prospect fields`;
    - `create action path sends event` (assert via an injectable sender, or check the local dispatcher's record).
- [ ] **Step 2: Run** `pnpm exec tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-prospect-enrich.ts` and the DB selftest. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both, plus `selftest-ai-suggestions.ts`, `selftest-ai-suggestions-db.ts`, and `pnpm exec tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(prospects): AI enrichment into the suggestions queue`.

### Task 7: Suggestions queue support for prospects (scope, display, accept)

**Files:**
- Modify:
  - `src/lib/ai/suggestions/service.ts`: owner/name joins in `listSuggestions`, `countMyPending` and `decideSuggestion` queries add `LEFT JOIN prospects p ON s.entity_type = 'prospect' …`; owner expression `COALESCE(d.owner_id, c.owner_id, p.claimed_by, p.created_by)`; entity name falls back to `p.company_name`.
  - `src/lib/ai/suggestions/appliers.ts`: real appliers for the four fields, calling `updateProspect(tenantId, { userId, role }, prospectId, { <field>: value })`, with product_fit → `productFitOfferingId` and size_band → `sizeBand`.
  - `src/lib/ai/suggestions/view.ts`: labels and formatting for the new fields; link `/dashboard/prospects?p=<id>`.
  - `src/app/dashboard/suggestions/**`: wherever it builds entity links, add the prospect case.
  - `src/app/dashboard/prospects/_components/prospect-drawer.tsx` and `page.tsx`: an "AI suggestions" section listing pending suggestions for the open prospect, with accept/reject using the existing suggestion actions and components.
  - `scripts/selftest-ai-suggestions-db.ts` or `scripts/selftest-prospects-db.ts`.

- [ ] **Step 1: Failing DB tests:**
  - `suggest: prospect suggestion visible to its claimer, and to creator when unclaimed`;
  - `suggest: manager sees team's prospect suggestions`;
  - `suggest: other rep doesn't`;
  - `accept: writes industry via updateProspect and bumps activity`;
  - `accept: product_fit sets offering id`;
  - `accept: promoted prospect → not applied, error 'Already promoted to a lead.'` (the suggestion stays pending or becomes stale per the existing decide semantics; assert which);
  - `reject: no write`;
  - `stale: field changed after suggestion → stale on decide` (existing behaviour, now for prospects);
  - existing deal/contact suggestion tests unchanged.
- [ ] **Step 2: Run** the DB selftests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `selftest-ai-suggestions.ts`, `selftest-ai-suggestions-db.ts`, the prospects DB selftest, and `pnpm exec tsc --noEmit`. Expected: all pass. Then a controller browser check: `/dashboard/suggestions` shows a seeded prospect suggestion that links to the drawer; accepting it updates the card.
- [ ] **Step 5: Commit** `feat(prospects): review AI suggestions for prospects`.

### Task 8: Seed and full verification

**Files:**
- Modify: `scripts/seed-prospects.ts`

- [ ] **Step 1: Seed additions.** 2 promoted prospects, created through `promoteProspect` so the leads, notes and routing are real. 3 pending enrichment suggestions on unclaimed prospects, inserted directly via `persistSuggestions` with fixed values; no Claude. `--reset` removes the seeded leads' deals, notes and activity created by promotion, plus the seeded suggestions.
- [ ] **Step 2:** Run `pnpm seed:prospects -- --tenant test-1 --reset` twice. Counts must be stable: 30 prospects, 2 promoted with 2 linked deals, 3 pending suggestions.
- [ ] **Step 3:** Pass all of:
  - `pnpm exec tsc --noEmit`;
  - eslint on the touched dirs;
  - prospects (pure and DB), prospect-import, prospect-enrich, dedup, ai-suggestions (pure and DB) and lead-capture selftests (the full `pnpm selftest` chain still stops at the pre-existing `selftest-forecast` failure).
- [ ] **Step 4:** Browser pass as rep, manager, owner and viewer:
  - promote with and without matches;
  - bulk promote;
  - settings page (owner only);
  - suggestions accept/reject from the drawer and the queue;
  - run `runProspectMaintenance` once via a tsx one-liner on the test DB after back-dating one prospect, and see it parked on the board.
- [ ] **Step 5: Commit** `feat(prospects): seed promoted prospects and suggestions`.
