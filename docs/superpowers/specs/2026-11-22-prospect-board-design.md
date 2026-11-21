# Prospect Board: a pre-lead staging area

Date: 2026-11-22 · Status: draft for approval · Size: project (4 stages)

## Why

The sales team collects potential clients from everywhere (trade-show lists,
visiting cards, LinkedIn screenshots, colleagues' tips) and today has nowhere to
put them that isn't a Lead. Creating a Lead too early pushes unqualified names
into routing, SLAs, pipeline and targets. The Prospect Board is a shared
scratch space: dump fast, organise, discuss, vote, claim, and only then promote
to a Lead, through the same dedup and distribution a Lead gets today.

## Goals

- Dump many prospects at once from free text, CSV, or an image; review in an
  editable grid before anything is saved. Every import carries a `source_tag`.
- A kanban board by stage (dump → researching → qualified → ready, plus parked)
  with group-by, filters, bulk select, and a card drawer (edit, comments with
  @mentions, votes, claim/release).
- Promote (single and bulk) creates a Lead (a `deals` row, stage `lead`) only
  after the existing dedup finds no match, then routes it through the existing
  distribution rules.
- Stale prospects park themselves; expired claims release themselves; both
  configurable per tenant.
- On create, Claude proposes industry / size band / product fit / ICP score with
  reasoning into the existing AI suggestions queue. A human accepts or rejects.
- A manager report: added per rep/source, conversion %, days in stage, stale count.

## Non-goals

- No change to how Leads, dedup, distribution, or the suggestions queue behave
  for their existing callers.
- No new role. No new notification channel. No new comments system.
- No prospect-level email/call logging (activity happens after promotion).
- No un-promote. A promoted prospect stays read-only and links to its lead.

## Anti-goals

- AI never writes a prospect field directly; only an accepted suggestion does.
- A prospect never shows up in pipeline, forecast, targets, or lead reports.
- No duplicate implementation of dedup, distribution, comments, notifications,
  CSV parsing, or the suggestions queue.
- Promote must never create a lead that the existing dedup would have flagged.

## Constraints (from the codebase)

- Next.js 16 (read `node_modules/next/dist/docs/` before writing route code;
  see AGENTS.md). Drizzle ORM, Postgres with per-tenant RLS via
  `app.tenant_id` (`runWithTenantContext` / `tenantTransaction` in
  `src/lib/db-context.ts`).
- **There is no `leads` table.** A Lead is a `deals` row with `stage = 'lead'`.
  The spec's `leads.source_prospect_id` is `deals.source_prospect_id`.
- **There are no accounts / customers tables.** Dedup targets are `companies`
  and `contacts` (`src/lib/dedup/queries.ts`).
- **Roles are** owner / admin / manager / member / viewer (`src/lib/rbac.ts`).
  "Rep" = `member`. "Manager" = `manager` plus owner/admin above it.
- Migrations: hand-written idempotent SQL in `drizzle/NNNN_*.sql`, applied by
  `scripts/apply-NNNN.ts` and chained into the `build` script. This feature is
  `0079_prospect_board.sql` (next free number; check at build time).
- Tests are `scripts/selftest-*.ts` run by `pnpm selftest`; DB tests run against
  the Docker test DB (`crm-test-pg`, port 15434, via `.env.local`). The `.env`
  DB is production; never run tests or seeds against it.
- Images may be sent to Claude (user confirmed 2026-11-22). Claude is already
  used via `@anthropic-ai/sdk` (`src/lib/ai/suggestions/extract.ts`,
  `src/lib/telephony/ai-summary-claude.ts`); follow their client/config pattern.
- Inngest v4 is already wired (`src/lib/inngest/`, `/api/inngest`), including a
  local dispatcher for dev.

## Approaches considered

- **A. Separate `prospects` table, built in four mergeable stages (chosen).**
  Prospects are isolated from every deal query. Each stage is reviewable and
  usable on its own; the board can be tried before promote/AI exist.
- B. Same design in one branch. Same work, one large hard-to-review change,
  nothing usable until the end.
- C. Prospects as deals in new pre-`lead` stages. Maximum reuse, but every
  pipeline, forecast, target, report and routing query would need to exclude
  them; one miss pollutes sales numbers. Rejected.

The user picked A.

## Data model (migration 0079)

All new tables: `tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE`,
ENABLE + FORCE RLS, the four standard tenant policies, `GRANT … TO app_user`,
revoke from anon/authenticated: copy the DO-block from `0077_ai_suggestions.sql`.
Drizzle schema in `src/db/schema/prospects.ts`, exported from the schema index.

### `prospect_stage` enum
`dump | researching | qualified | ready | parked`.

### `prospects`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id | uuid | |
| company_name | text not null | |
| normalized_name | text | `normalizeCompanyName()`; trigram index like companies |
| domain | text | lower-cased, no scheme/`www.` |
| contact_name, contact_designation | text | |
| contact_email, contact_phone | text | as typed |
| email_normalized, phone_normalized | text | existing normalizers (dedup / `libphonenumber-js`, as contacts use) |
| industry | text | free text, like `companies.industry` |
| size_band | text | CHECK in `1-10, 11-50, 51-200, 201-1000, 1000+` |
| city, state | text | **territory** (my call: matches `deals.lead_city/lead_state`, which distribution conditions read) |
| product_fit_offering_id | uuid → offerings, set null | my call; on promote fills `deals.lead_product_interest` with the offering name |
| icp_score | smallint | 0–100 CHECK |
| cluster_tags | text[] not null default '{}' | |
| source_tag | text not null | |
| import_id | uuid → prospect_imports, set null | |
| notes | text | |
| stage | prospect_stage not null default 'dump' | |
| stage_changed_at | timestamptz not null default now() | |
| parked_reason | text | `stale` \| `manual`, null unless parked |
| claimed_by | text | user id (users are text ids, like `deals.owner_id`) |
| claimed_at, claim_expires_at | timestamptz | |
| promoted_deal_id | uuid → deals, set null | unique per tenant where not null |
| promoted_at, promoted_by | | |
| last_activity_at | timestamptz not null default now() | see "Activity" below |
| created_by, created_at, updated_at, deleted_at | | soft delete like other entities |

Indexes: `(tenant_id, stage) WHERE deleted_at IS NULL`, `(tenant_id, claimed_by)`,
`(tenant_id, source_tag)`, GIN trigram on `normalized_name`,
`(tenant_id, last_activity_at)` for the auto-park job.

### `prospect_stage_history` (my call: needed for "avg days in stage")
`id, tenant_id, prospect_id → prospects cascade, from_stage (nullable), to_stage,
changed_by (user id or 'system:auto-park'), changed_at`. Written in the same
transaction as every stage change, including the initial insert (from = null).

### `prospect_votes`
`tenant_id, prospect_id → prospects cascade, user_id, kind ('know_someone' |
'priority'), created_at`, PK `(prospect_id, user_id, kind)`. Toggle on/off.

### `prospect_imports`
`id, tenant_id, source_tag not null, input_kind ('text'|'csv'|'image'),
raw_text (text input or CSV body), raw_file_path (image, in Supabase storage via
`src/lib/storage`; a new private bucket with signed-URL reads (my call). The
existing helpers only return public URLs, so this is new code), parser_model, parser_output jsonb,
status ('parsed'|'confirmed'|'discarded'|'failed'), rows_parsed, rows_inserted,
error, created_by, created_at, confirmed_at`.

### Comments: reuse `comments`
`entity_type = 'prospect'`, `entity_id = prospects.id`. No `prospect_comments`
table. Mentions use the existing `@[Name](user-id)` format and
`mentioned_user_ids` fan-out to `recordNotifications`. Allowlists to extend
with `prospect`: `ENTITY_TYPES`, `PERMISSION_FOR`, `PATH_FOR` in
`src/app/dashboard/comments/actions.ts`, and `ACTIVITY_ENTITY_TYPES` in
`src/db/schema/activity-logs.ts` (the comment action logs on the parent).

### Changes to existing tables
- `deals.source_prospect_id uuid REFERENCES prospects ON DELETE SET NULL`, indexed.
- `organization_settings`: `prospect_claim_days int default 14`,
  `prospect_claim_expiry_enabled bool default true`,
  `prospect_auto_park_days int default 45`,
  `prospect_auto_park_enabled bool default true`,
  `prospect_enrichment_enabled bool default false` (my call: matches
  `ai_suggestions_enabled` defaulting off; enrichment also requires that flag).
- `ai_suggestions`: widen CHECKs. `entity_type` += `prospect`; `field` +=
  `industry, size_band, product_fit, icp_score`; `source_type` += `enrichment`.
  Same for `ai_suggestion_sources.source_type`. For enrichment rows
  `evidence_quote` holds Claude's reasoning (≤500 chars) and the
  quote-in-source check is skipped (my call: enrichment has no source text).
  `source_id` = prospect id, so the existing unique index makes it run once.
- `lead_sources`: add type `prospect_board` (CHECK + `LEAD_SOURCE_TYPES`). One
  row per tenant named "Prospect Board", created lazily like
  `ensureCsvImportSource` (my call: lets distribution rules target promoted
  leads by source type).

## Behaviour

### Activity
`last_activity_at` bumps on: field edit, stage change, comment, vote, claim,
release. The auto-park job reads only this column.

### Quick Dump (stage 2)
- `POST /api/prospects/import` (route handler, multipart): `source_tag`
  (required) plus one of `text`, `file` (CSV), `file` (image: png/jpg/webp,
  ≤5 MB, my call).
- CSV: parse with the existing `src/lib/lead-capture/csv.ts`; map headers with
  the existing `suggestColumnMapping` pattern extended to prospect fields. No
  Claude call when every column maps cleanly; otherwise Claude normalises rows.
- Text and image: one Claude call with a strict JSON schema (array of prospect
  rows, each field nullable, plus a per-row `confidence`). Model and client
  config follow `src/lib/ai/suggestions/extract.ts`. Treat input as untrusted
  data, never instructions.
- Store the import row (`parsed`) and return rows to a preview grid. The user
  edits/deletes rows, then `confirmImport(importId, rows)` (server action)
  inserts prospects with `source_tag` and `import_id` and sets the import to
  `confirmed`. Each preview row shows a dedup hint (existing prospect / company /
  contact match), but nothing blocks at dump time.
- Limits: 500 rows per import (my call).

### Board (stage 1)
- Route `/dashboard/prospects`. Kanban columns = stages (parked collapsible).
  Drag via `@dnd-kit` (already installed). Drag to a stage = stage change +
  history row.
- Group by: industry | territory (state, then city) | product_fit | source_tag:
  swimlanes within the kanban (my call).
- Card: company, contact, source_tag, cluster tags, product fit, ICP score,
  claim status (avatar + days left), vote counts.
- Filters: mine (claimed by me OR created by me, my call), unclaimed, source,
  stage. URL query-string state like other list pages.
- Bulk select: move stage, park, promote, release claim (each permission-checked).
- Drawer: edit fields, comments, votes, claim/release, promote, and pending AI
  suggestions for that prospect (accept/reject inline, reusing the suggestions
  components).
- Promoted prospects: hidden from the board by default (toggle "show promoted"),
  read-only drawer with a link to the lead.

### Claims
- Claim sets `claimed_by = me`, `claim_expires_at = now + prospect_claim_days`.
  Claiming an already-claimed prospect fails unless the caller is a manager
  (reassign). Release by the claimer or a manager. Re-claiming your own
  prospect extends the lock.
- What a claim locks (user decided 2026-11-22): only the claimer or a manager
  can move its stage, park, or promote it. Anyone with `manageProspects` can
  still view, edit fields, comment and vote. Drag-and-drop and bulk actions
  skip locked cards with a per-card reason.

### Visibility (my call)
- The board is tenant-wide: every role sees every prospect (it is a shared
  scratch space). Viewers read-only.
- A prospect's "owner" for scoping = `COALESCE(claimed_by, created_by)`.
  The suggestions queue's scope expression gains a prospect branch using it,
  so a rep reviews suggestions on prospects they claimed/created and managers
  see their reports' via the existing subtree rules. No existing rows change
  scope (no prospect suggestions exist today).
- Managers reassign claims and see report rows for their subtree
  (`scopeUsers`); owner/admin see all.

### Promote (stage 3)
Single and bulk server action. For each prospect, in its own transaction:
1. Reject if already promoted, deleted, parked (unpark first), claimed by
   someone else and the caller isn't a manager, or caller lacks permission.
   Requires company name plus contact email or phone (my call: lead dedup,
   SLA first-touch and the CSV import all key off the contact). Allowed from
   any other stage.
2. Dedup, reusing `src/lib/dedup/queries.ts`:
   - company name: `findCompanyMatches` (exact + fuzzy + first-word rule);
   - domain exact against `companies.domain` (new small helper in dedup/queries.ts);
   - email exact: `findContactByEmail`;
   - phone exact against `contacts.phone_normalized` (new small helper);
   - also an open lead (`deals` stage `lead`, not deleted) whose company
     matches: by `company_id` against the matched companies, AND by trigram on
     `deals.company_name_text` (captured/imported leads have no `company_id`).
3. Match handling (user decided 2026-11-22):
   - **Strong matches block**: exact normalized company name, domain, email,
     phone, or an open lead for the same company. No write; return the matches.
   - **Fuzzy / first-word company matches warn only**: returned as warnings;
     the user acknowledges and continues (bulk: listed per row, an "ignore
     warnings" checkbox for the batch).
   - **Merge** (offered on a block): the user picks from the matched
     candidates. If they pick an open lead: link the prospect to it
     (`promoted_deal_id`), copy notes/comments to it, mark promoted, no new
     lead, no routing. If they pick a company and/or contact: create the new
     lead under the picked company/contact instead of creating new ones, then
     continue at step 4's remaining work.
   - **Create anyway**: managers only; sets `dedup_override` on the new company.
4. No match: create company, contact, deal (`stage = 'lead'`,
   `source = 'Prospect Board: <source_tag>'`, `lead_source_id` = the tenant's
   Prospect Board source, `company_id`, `company_name_text`, `lead_city/state`,
   `lead_product_interest`, `source_prospect_id`) in new synchronous code
   (`src/lib/prospects/promote.ts`). The CSV/ingest path can't be reused:
   `processIngestEvent` is async, needs a `lead_ingest_events` row, and never
   creates a company. Promote does reuse its pieces: the contact normalisers,
   `normalizeCompanyName`, and the same column set on the deal. Copy prospect
   notes into the `notes` table on the new deal; copy each comment as a note
   whose body is prefixed with "Comment by <name> on <date>:" (notes rows are
   stamped now; the original author and time live in the text). Record one
   `recordActivity` entry on the deal: "Promoted from Prospect Board".
5. Mark the prospect promoted (`promoted_deal_id/at/by`). Ownership (user
   decided 2026-11-22): **if claimed, the lead goes to the claimer**: set
   `deals.owner_id`, `routing_status = 'assigned'` and open a
   `lead_assignments` row the same way `reassignLead`
   (`src/lib/lead-capture/sla.ts`) does (SLA default 30 min,
   `assigned_by = 'prospect:claim'`), then `notifyAssigned`, so SLA and
   "already assigned" logic see it. Distribution is not called. **If unclaimed**, after
   commit call `distributeLead({ tenantId, dealId })`. `distributeLead` itself
   is unchanged.
- Bulk returns per-row outcome: promoted / blocked (with matches) / failed.

### Inngest jobs (stage 3)
- `prospects/daily-maintenance`, cron daily 02:00 IST (my call), fan out per
  tenant: park non-promoted prospects with `last_activity_at < now - N days`
  (stage → parked, `parked_reason = 'stale'`, history row by `system:auto-park`);
  clear claims with `claim_expires_at < now`. Each respects the tenant's
  enabled flag and day count. Notify the claimer on expiry (my call).
- `prospects/enrich` on event `prospect.created` (sent after confirmImport and
  manual create), only when both enrichment and `ai_suggestions_enabled` are on.
  Claude (structured output) returns industry, size_band, product_fit (must be
  one of the tenant's active offerings), icp_score, each with reasoning and
  confidence → `persistSuggestions` with `entity_type = 'prospect'`. Accepting
  goes through new prospect appliers that call the same update action as a
  manual edit. Batch fan-out for imports (one event per prospect, throttled).

### Permissions (add to `src/lib/rbac.ts`)
| permission | roles |
|---|---|
| `manageProspects` (create, edit, comment, vote, move stage) | owner, admin, manager, member |
| `claimProspects` | member (reps), plus owner/admin/manager so they can work prospects too (my call) |
| `promoteProspects` | owner, admin, manager, member |
| `manageProspectClaims` (reassign/release others) and `bulkParkProspects` | owner, admin, manager |
| `viewProspectReports` | owner, admin, manager |
Viewer: read-only. Every server action re-checks; UI hides what you can't do.

### Reporting (stage 4)
Manager page `/dashboard/prospects/report` (or a tab on reports), date-range filter:
- prospects added per rep (created_by) and per source_tag;
- prospect → lead conversion % by source_tag, cluster tag, rep (promoted_by
  falling back to claimed_by at promotion, my call);
- avg days in each stage from `prospect_stage_history`;
- stale count: non-promoted, not parked, `last_activity_at` older than half the
  auto-park threshold (my call), plus count auto-parked in range.
Follow the patterns in `src/lib/reports/`.

### Seed
`scripts/seed-prospects.ts` (`pnpm seed:prospects`): 30 prospects across 3
source tags (e.g. "Trade show 2026", "LinkedIn", "Referral"), spread across
stages, some claimed, some voted/commented, a few promoted, with stage history.
Refuses to run against the production DB URL.

### Tests (selftest scripts, test DB)
- `selftest-prospects.ts` (pure): import row validation, size band, filters,
  permission matrix, stale/claim-expiry selection.
- `selftest-prospects-db.ts`: RLS isolation, stage history, claim/reassign rules,
  vote toggle, promote happy path (deal fields, source_prospect_id, notes copied,
  distribution called), promote blocked on each dedup kind, merge path, bulk
  mixed outcomes, daily job, enrichment persists suggestions and never writes
  fields (Claude stubbed via injected `create` like `extract.ts`).
- Import route: text / CSV / image with a stubbed Claude client.

### README
A "Prospect Board" section: what it is, the stages, settings, permissions,
Inngest jobs, seed command.

## Stages (each a mergeable branch)
1. Migration 0079 (whole data model), schema, RBAC, board UI, manual create,
   drawer edit, filters/group-by/bulk stage moves, seed, selftests.
2. Quick Dump, comments + mentions, votes, claim/release/reassign.
3. Promote (single/bulk, dedup, merge), daily job, enrichment + appliers.
4. Manager report, README.

## Left to the builder
Component structure, query shapes, Claude prompt wording, swimlane visuals,
exact Inngest function ids, file layout under `src/lib/prospects/`.
