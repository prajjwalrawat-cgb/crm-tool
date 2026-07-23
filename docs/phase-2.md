# Phase 2 — Salesforce-Tier Platform Depth

Six structural modules closing gaps against Salesforce Sales Cloud. All business
logic is server-side; the client renders what the API returns. Every module is
gated by a per-workspace feature flag (except Module 6) stored in
`workspace_settings`, defaulting **ON for the CGB workspace, OFF for others**.

## Modules

### 1. Stage-Gate Enforcement ("Path") — `STAGE_GATES_ENABLED`
Admin-defined per-stage entry requirements; a deal cannot advance into a gated
stage until they're met (hard block, not a warning).
- `stage_gates` table; `evaluateStageTransition()` implements all six rule types
  (`field_required`, `min_stakeholders`, `min_activities`, `amount_required`,
  `task_complete`, `custom_note`).
- Enforced at **every** stage-mutation site: kanban drag, edit-form dropdown,
  create, and CSV bulk upload. `block` rejects (422-style); `warn` allows + logs
  a `gate_warning` activity.
- UX: blocked-drag slide-over with per-rule fix CTAs, a Salesforce-style Path
  chevron bar on the deal page, and a **Settings → Stage Gates** admin page.

### 2. Deal Health Score — `DEAL_SCORING_ENABLED`
A deterministic 0–100 rule-based Opportunity Score per open deal.
- Pure `computeDealScore()` (weighted rubric from a baseline of 50); every point
  of deviation is explained in `reasons`. Currency-aware amount rule; workspace
  stage medians from `deal_stage_history`.
- `deal_scores` is append-only (trend history); `deals.health_score/health_band`
  are a denormalized current-value cache (written via raw SQL so `updated_at`
  isn't bumped).
- Recompute: `crm/deal.health_recompute` event with a **5-min per-deal debounce**
  (emitted from every scoring-signal mutation) + a nightly cron.
- UX: kanban score-band border + chip (old last-activity border removed — one
  health system), a Deal Score card (sparkline + reasons), a Score pipeline
  filter.

### 3. Automatic Email Activity Capture (Gmail) — `EMAIL_SYNC_ENABLED`
Emails between reps and deal contacts appear on the right deal automatically.
- Reuses `email_messages` (`direction: inbound`, `provider: gmail`,
  `provider_message_id`). Per-user `gmail_connections`; refresh tokens
  **AES-256-GCM encrypted** at rest. Reads use `format=metadata` — subject +
  ≤200-char snippet only, **never bodies/attachments**.
- Matching pipeline: counterparty → contact (case-insensitive email) → deal
  (one → attach; many → most recent + `needs_review`; none → contact). Idempotent
  (partial unique index); a non-matching message is written **nowhere**.
- 10-minute Inngest sync cron (`history.list` incremental + 7-day fallback).
  OAuth connect/callback routes + per-user **Settings → Email Sync** page.
- Downstream: synced emails count as genuine activity for Modules 1 & 2, and
  activate the Relationship Health card.
- **Production note:** `gmail.readonly` is a Google *restricted* scope. For
  external multi-tenant use you need Google OAuth verification + a CASA security
  assessment, or a third-party provider (Nylas/Unipile). Testing mode (added
  test users) is fine for validation.

### 4. Forecast Rollup — `FORECASTS_ENABLED`
Manager-level pipeline aggregation under **Executive → Forecast**.
- `deals.forecast_category` (pipeline | best_case | commit | closed_won |
  omitted), auto-derived from stage, manually overridable
  (`forecast_category_overridden`); stage changes re-derive only when not
  overridden.
- `getForecastRollup` sums `amount_minor` raw + weights by stage probability
  (board-consistent — a test asserts the grand total reconciles with the board).
  Open past-dated deals are partitioned into an "Overdue — needs re-forecast"
  row, excluded from Commit/Best-case.
- Fiscal-aware quarter/month period selector; owner × category matrix with
  click-through; weekly `forecast_snapshots` cron (Mon 00:30 IST) for a "vs last
  week" delta.

### 5. Duplicate Detection Guardrails — `DEDUP_ENABLED`
Stops dedup debt at creation and surfaces existing debt for cleanup.
- `pg_trgm` + `normalized_name` (punctuation + legal suffixes stripped) with GIN
  trigram indexes on companies + contacts.
- Creation-time: debounced "similar company" panel; duplicate contact email is a
  hard block (with a link to the existing contact).
- **Settings → Data Quality** (admin): ranked duplicate pairs with a human-click
  merge. `mergeRecords` repoints every child record (hard FKs + all polymorphic
  `entity_type/entity_id` tables), soft-deletes the loser (`merged_into_id`, so
  it vanishes from lists + search), and writes a `merge_audit` row with the full
  loser snapshot for reversibility. Never auto-merges.

### 6. Hold-Stage Cleanup — always on
Hold becomes a reasoned parking state.
- Moving to Hold requires a reason code + a "revisit on" date (`hold_reason`,
  `hold_revisit_on`, `hold_note`). Board drag opens a modal; the deal detail
  page has a "Put on hold" control (the first-hold path).
- Board: empty Hold column hidden; non-empty renders as a slim collapsed lane
  (count + total, expandable).
- Held deals are frozen (skipped by scoring, "On hold" chip), omitted from the
  forecast (out of Commit/Best-case + the overdue row), and skipped by the
  stale-deal scan.
- Daily cron creates an owner "Revisit held deal" task when the revisit date
  arrives (idempotent); a "Revisit due" pipeline filter surfaces them.

## Migrations
Hand-written SQL applied by idempotent `scripts/apply-00NN.ts` (wired into the
`build` npm script): `0049` (workspace_settings + stage_gates), `0050`
(deal_scores + deal health cache), `0051` (gmail_connections + email idempotency),
`0052` (forecast columns + snapshots), `0053` (dedup: pg_trgm + normalized_name +
merge_audit), `0054` (hold columns).

## Seed / ops scripts
- `pnpm seed:stage-gates` — turn CGB flags ON + seed default stage gates.
- `pnpm backfill:deal-scores` — score existing open deals.
- `pnpm gmail:sync-now` — run the Gmail sync once on demand (needs Gmail env).

## Tests
`pnpm selftest` runs all module suites (13 files): stage-gates, deal-scoring
(pure + service), gmail parse + ingest pipeline, forecast rollup, dedup normalize
+ merge, hold cleanup. `tsc --noEmit` and `next build` are clean.

## Environment (Module 3, optional)
```
GMAIL_CLIENT_ID=...          GMAIL_CLIENT_SECRET=...
GMAIL_OAUTH_REDIRECT_URI=<origin>/api/integrations/gmail/callback
EMAIL_SYNC_ENCRYPTION_KEY=<32+ random chars>
```
