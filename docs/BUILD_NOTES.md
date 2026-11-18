# Saleinx build notes: Prompt 0 foundation audit

Written 2026-11-14, before any feature work on lead capture, telephony or reporting.
This lists what the repo actually is, where it differs from what the build prompts
assume, and the assumptions later prompts will rely on. Review the **Open decisions**
section before Prompt 1 starts.

## What the repo is

| Area | What exists | Prompt assumed |
|---|---|---|
| Framework | Next.js 16.2 App Router (React 19). Mutations are mostly **Server Actions**; a few route handlers under `src/app/api/**/route.ts`. Read `node_modules/next/dist/docs/` before writing routes (AGENTS.md). | Express/Fastify |
| Hosting | Vercel, region `bom1` (serverless functions, no long-lived process) | unspecified |
| Package manager | pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`), single package, not a monorepo | |
| DB / ORM | Supabase Postgres via `postgres` (postgres-js) + **Drizzle ORM**. Schema in `src/db/schema/*.ts`, exported from `src/db/schema/index.ts`. `prepare: false` (transaction pooler). | Prisma/Drizzle/Knex/raw |
| Migrations | Hand-written SQL in `drizzle/NNNN_name.sql` (statements split by `--> statement-breakpoint`), each applied idempotently by `scripts/apply-NNNN.ts`, chained in the `build` script. Latest is **0071**. New migrations follow this pattern: 0072+, plus an apply script, plus a `build` entry. | migration tool |
| Tenancy | `tenant_id uuid NOT NULL` → `tenants.id` on every tenant table. Explicit `WHERE tenant_id = ?` **and** Postgres RLS (`FORCE ROW LEVEL SECURITY`, policies on `current_setting('app.tenant_id')`). Context comes from `runWithTenantContext` / `runWithSystemContext` (`src/lib/db-context.ts`, AsyncLocalStorage) and `tenantTransaction`, which calls `app_set_ctx()` (migration 0026) to `SET LOCAL ROLE app_user`. Fails closed when no context is set. | `tenant_id UUID` filter |
| Users | `users.id` is **`text`** (old Clerk ids like `user_2…`, new ones `usr_…`). Not under RLS. Every `owner_id`, `actor_user_id` and `assigned_user_id` column is `text`. | `UUID` |
| Roles | `memberships.role` enum: `owner, admin, manager, member, viewer`. Permission map in `src/lib/rbac.ts` (`can(role, perm)`); guards in `src/lib/auth-guard.ts` (`requirePermission`, `withTenantSession`). | rep / manager / admin |
| Inngest | `inngest` v4, client in `src/lib/inngest/client.ts` (typed `eventType(...)`), events in `events.ts`, functions in `src/lib/inngest/workflows/*`, served at `src/app/api/inngest/route.ts`. `sendWorkflowEvent` falls back to an **in-process dispatcher** with no retries and no durability when Inngest is not reachable. | Inngest |
| Tests | **No test framework.** Tests are `scripts/selftest-*.ts` run with `tsx`; DB-backed ones hit the real `DATABASE_URL`, create fixtures and clean them up. `pnpm selftest` chains them. Lint is `eslint`; typecheck is `tsc --noEmit`. | jest/vitest |
| AI | Main provider is **OpenAI** (`src/lib/ai/openai.ts`, `complete.ts`, embeddings, pgvector). `@anthropic-ai/sdk` is installed and used only in `src/lib/deals/risk/explain.ts`. | Claude API |
| Storage | Supabase Storage (`src/lib/storage/supabase.ts`), already used for invoice and deal-document buckets | S3-compatible |
| Realtime | An SSE endpoint already exists (`src/app/api/realtime/events`, `src/lib/realtime/*`) | SSE or websocket |
| UI | Tailwind 4, lucide icons, sonner, react-hook-form + zod, TanStack Query, Recharts, dnd-kit and @hello-pangea/dnd. Design was recently updated to a "salenix" theme. **Use that, not Midnight Executive.** | |
| Validation | zod v4 (+ drizzle-zod) | Zod |

## Where the prompts and the repo disagree

These are the points that need a decision before Prompt 1 (see **Open decisions** below).

1. **There is no `leads` table.** A lead is a `deals` row with `stage = 'lead'`, optionally linked to `contacts` (which has `email` and `phone`) and `companies`. The stage enum is `lead, qualified, proposal, negotiation, hold, won, lost`. Prompt 1's lead columns (`utm_*`, `consent_*`, `phone_normalized`, `email_normalized`, `last_enquiry_at`, `source_id`) and the dedupe key would go on `deals` and/or `contacts`, or on a new `leads` table.
2. **There are no teams and no reporting line.** There is no `teams` table and no `reports_to`. A manager is a role that sees the whole tenant. Prompt 1's `pool.team_id`, the "escalate to team manager" step and Prompt 3's "manager = reports-to subtree" scoping all need this to exist first.
3. **IDs are text, not UUID.** Every `user_id`, `assigned_to`, `fixed_owner_id` and `agent_ids` column in the prompts becomes `text`. `user_ids[]` in JSON pools are strings.
4. **Routes are Next.js route handlers, not Express.** `/public/ingest/:sourceId` becomes `src/app/public/ingest/[sourceId]/route.ts` (or under `/api/public/...`). Public routes need middleware/proxy exclusions so the session check does not redirect them.
5. **Rate limiting has no store.** On Vercel serverless an in-memory limiter does not work across instances, and there is no Redis. Options: a Postgres-backed counter table (simple, adds a write per request), Upstash Redis, or Vercel Firewall rules.
6. **Inngest fallback has no retries.** The prompts' "retries 5 with backoff", "retry distribution every 10 min up to 6h" and the 5-minute SLA cron need real Inngest Cloud in production (`INNGEST_EVENT_KEY` / signing key). The local fallback runs each event once.
7. **Stage history already exists.** `deal_stage_history` (migration 0045) is trigger-maintained, with one row per stage occupancy and `entered_at`/`exited_at` columns. It does not record `owner_id_at_change`, `source_id_at_change` or `changed_by`. `deal_audit_log` also exists. Prompt 3 should extend these, not create a parallel `lead_stage_history`.
8. **Reports already have a registry.** `src/lib/reports/registry.ts` plus `src/lib/reports/queries/*` cover funnel by offering, pipeline by stage, rep performance, stale deals, win/loss, velocity, forecast and email engagement. There are also `team-analytics`, `forecast-snapshots` and `team-metric-snapshots`. Prompt 3's metrics registry should extend this rather than add a second `src/reports/metrics.ts`.
9. **No tenant timezone.** Date formatters are pinned to UTC. Prompt 3's IST day buckets need a `timezone` setting (default `Asia/Kolkata`) in `organization_settings` or `workspace_settings`.
10. **No phone library.** `libphonenumber-js` is not installed. Dedupe today covers companies (trigram on name) and contacts (exact email) in `src/lib/dedup/*`; phone dedupe would be new.
11. **AI and data residency.** Earlier guidance on this project was to keep document reading local and not send it to cloud AI. Prompt 1 sends 5 sample CSV rows (names, phones, emails) to Claude, Prompt 2 sends call transcripts, and Prompt 3 sends aggregates only. That needs explicit sign-off, or a design where only headers are sent. The heuristic fallback exists either way.
12. **Activity log shape.** `activity_logs` is the audit timeline: `entity_type`, `entity_id` (text), `action`, `metadata` jsonb, `actor_user_id`. Calls, re-enquiries and "first touch" would be new actions here. There is no outbound call or WhatsApp activity today. Emails come from the Gmail sync / `communication_*` tables, so the first-touch hook has to listen in those places too.
13. **External prerequisites outside the code.** Exotel account and API keys, an STT provider, a Meta app with page token, hCaptcha/Turnstile keys, and a `KMS_KEY` env for credential encryption.

## Assumptions later prompts will use (unless overridden)

- New tables follow the repo convention: `uuid` PK `defaultRandom()`, `tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE`, RLS enabled and forced with the four standard policies, grants to `app_user`, `timestamptz` columns, and a Drizzle schema file plus an export from `schema/index.ts`.
- All user references are `text`.
- Public/webhook endpoints run under `runWithSystemContext(tenantId)` after resolving the tenant from the source/account row. The lookup itself runs before tenant context exists, so the lookup tables (`lead_sources`, `telephony_accounts`) need a narrow `SECURITY DEFINER` lookup function, or must be read without RLS, the same way `tenants` and `users` are.
- New tests are `scripts/selftest-*.ts` and get added to `pnpm selftest`.
- Claude calls use `claude-sonnet-5-5` via the installed `@anthropic-ai/sdk`. Every response is zod-validated and has a non-AI fallback.

## Open decisions (needed before Prompt 1)

1. **Lead model:** keep leads as `deals(stage='lead')` with the new columns on `deals` and the normalized phone/email on `contacts`, or introduce a real `leads` table that converts into a deal? The first fits everything that exists (board, reports, scoring); the second matches the prompts literally but splits the pipeline.
2. **Teams:** add `teams` + `team_members` + `memberships.reports_to`, or keep "manager sees the whole tenant" for now?
3. **Rate limiting store:** Postgres table, Upstash, or Vercel Firewall?
4. **Is Inngest Cloud configured in production?** It is required for retries, crons and the SLA watchdog.
5. **Sending lead PII to Claude** for CSV mapping (5 rows), or headers only?
6. **Scope per session:** Prompt 1 alone is estimated at 5–7 engineer-days. Build it in slices (schema + ingest + dedupe → distribution + SLA → UI), with review between slices?

## Decisions taken (2026-11-14, proceeding on the recommended defaults)

The open decisions above were not answered, so Prompt 1 proceeds on the defaults below. Any of them can be reversed before the UI slice.

1. **Leads stay `deals(stage='lead')` + `contacts`.** Capture columns go on `deals` (`lead_source_id`, `utm_*`, `landing_url`, `referrer_url`, `consent_*`, `last_enquiry_at`, `lead_city`, `lead_state`, `lead_product_interest`, `routing_status`, `routing_queued_at`). Dedupe keys go on `contacts` (`phone_normalized`, `email_normalized`). The `Deal`/`Contact` TS types omit these columns; `DealRecord`/`ContactRecord` are the full rows.
2. **No teams yet.** `pool.team_id` is not supported. "Escalate to team manager" goes to every active owner/admin/manager in the workspace.
3. **Rate limiting uses Postgres**: the `rate_limit_hits` table and the `rate_limit_hit()` function (fixed one-minute window). It fails open on a database error so a lead is never dropped. Old windows are pruned by the SLA cron.
4. **Inngest Cloud is assumed in production.** Without it, events run once in-process (no retries) and the crons don't run.
5. **CSV mapping via Claude (later slice) sends headers only**, never sample rows. That keeps lead PII local, in line with the earlier "no cloud AI on documents" rule. The heuristic alias matcher in `src/lib/lead-capture/mapping.ts` is the fallback.
6. **Built in slices.** Slice 1 (this one) is backend only: schema, ingest, dedupe, distribution, SLA and first touch.

## Further assumptions made in slice 1

- Event names follow the repo convention `crm/<entity>.<verb>`: `crm/lead.ingest_received`, `crm/lead.created`, `crm/lead.reassign_requested`, `crm/lead.assigned`, `crm/lead.unassigned`. The prompt's names were `lead/ingest.received` etc.
- The public route is `/api/public/ingest/[sourceId]`, not `/public/ingest/...`, so it sits under the existing API matcher. `/api/public/` is added to the middleware's public prefixes.
- The tenant for a public request is resolved through `lead_source_public_lookup(uuid)`, a `SECURITY DEFINER` function that returns one source's tenant, secret, active flag and allowed origins. All later work runs under `runWithSystemContext(tenantId)`.
- `user_routing_profile` is keyed `(tenant_id, user_id)` because users can belong to several workspaces. A user with no profile counts as available 24/7.
- "Open new leads" for `capacity_cap` = open assignments with no first touch. "Load" for `least_loaded` = open assignments made in the last 7 days.
- Rule selection order: non-default rules by priority → the source's `default_rule_id` → the tenant default rule (`is_default`, at most one per tenant).
- First touch = the owner records `call_logged`, `meeting_logged` or `email_sent`, or a note (`updated` with `metadata.noteId`), on the deal. An outbound `email_synced` also counts. The hook lives in the activity recorder (`src/lib/lead-capture/first-touch.ts`).
- A re-enquiry on a deal lost more than 30 days ago reopens it to stage `lead`. Lost → lead is not a rollback under the 0060 governance trigger.
- Phone validation uses libphonenumber's `min` metadata, which checks length only. This is enough for consistent dedupe keys and keeps the bundle small. `libphonenumber-js` was added at 1.12.10. The lockfile was patched by hand to add only that package, because pnpm 10.12 rewrote unrelated `libc` fields.
- Captured leads and re-enquiries are timeline `automation_note` rows (`metadata.kind` = `lead_captured` / `lead_reenquiry` / `lead_sla_breach`). Assignments are `owner_changed` rows. New notification types: `lead_assigned`, `lead_unassigned`, `lead_sla_breach`.

## Prompt 1: slices 2–3 (UI, forms, import, Meta)

Built:
- **Settings › Lead sources:** endpoint and secret (reveal, copy, rotate), curl examples, field mapping editor, fallback rule, allowed origins, Meta config, "Send test lead", and the last 50 payloads with retry.
- **Settings › Capture forms:** field builder with drag-to-reorder, live preview, publish, and the hosted URL plus embed snippet.
- **Settings › Distribution:** drag-to-reprioritise rule list, rule editor with a condition builder, a Simulate panel showing per-person eligibility, and routing profiles (availability, working hours, skills, regions).
- **Leads › Lead queue:** filters, bulk assign, and select all matching the filter.
- **Leads › Import leads:** wizard with header-only AI mapping, a 20-row review with row errors, and a progress bar.
- **Deal page:** a "Lead routing" card with source, UTM, consent, assignment history and reassign.
- **Public:** hosted forms at `/f/<workspace>/<form>`, `/embed/form.js` (shadow DOM, textContent only), the form definition and submit endpoints (honeypot, time trap, consent, CORS against allowed origins, optional Turnstile, 20/min/IP), and the Meta webhook (`hub.verify_token` = source secret, `X-Hub-Signature-256` with `META_APP_SECRET`, Graph fetch with the source's page token).
- **REST routes** for simulate, reassign, ingest-event list and retry, and job progress. Source, form and rule CRUD are server actions, not REST.
- **Permissions:** `manageLeadCapture` (owner, admin), `assignLeads` and `importLeads` (owner, admin, manager).
- **`seed:lead-capture`.**

Extra assumptions:
- 0072 gained `lead_sources.config`, `lead_import_jobs` and `capture_form_public_lookup()`. 0072 had not been applied anywhere yet, so it was extended rather than adding 0073 (which telephony owns).
- Page tokens are stored in `lead_sources.config` without encryption. Move them to the AES-GCM credential helper from Prompt 2 (`KMS_KEY`) once it exists.
- The CSV import limit is 4 MB, because Vercel caps request bodies at 4.5 MB. The file goes through a server action, not a storage upload.
- The installed Anthropic SDK (0.94) predates the server-side `fallbacks` parameter. A refusal or invalid mapping falls back to the heuristic matcher instead.
- "Today's Focus" doesn't exist in this codebase. Assignment notifications go to the bell (type `lead_assigned`).

Still not done for Prompt 1:
- The DB-backed self-test (`pnpm selftest:lead-capture-db`) has not been run, because the only configured database looks like production.
- There is no browser test of the embed on a different origin. It needs a running app.

## Prompt 2: Telephony (2026-11-14)

### Decisions

- **Exotel first, from its docs.** The adapter follows `docs/telephony-provider-notes.md`, which was written from Exotel's developer docs before the adapter existed. Knowlarity, Ozonetel, MyOperator and Twilio are registered and throw `NotImplementedError`. A `mock` provider exists for tests; production uses it only when `TELEPHONY_ALLOW_MOCK=true`.
- **Webhook auth.** Exotel signs nothing. Each account has a `webhook_secret`, carried as `?s=` in the callback URL and compared in constant time. An optional IP allowlist comes from env `EXOTEL_WEBHOOK_IPS`. The route is `/api/public/telephony/[provider]/[accountId]/webhook` (GET and POST), under the existing `/api/public/` middleware exemption, and is rate limited with the 0072 Postgres limiter.
- **Credentials.** AES-256-GCM with env **`KMS_KEY`** (64 hex characters or base64 32 bytes). Saving an account fails with a clear message when it is missing. Layout: `v1 ‖ iv ‖ tag ‖ ct`.
- **`calls.lead_id` = deal id**, keeping the prompt's column names for Prompt 3 (`tenant_id, user_id, lead_id, contact_id, direction, status, started_at, answered_at, ended_at, duration_sec, talk_time_sec, disposition`). Lookup columns `from_number_normalized` / `to_number_normalized` were added.
- **Row before provider.** Click-to-call inserts the row with `provider_call_id = 'pending:<id>'`, then dials. Exotel echoes our id back in `CustomField`, so the first webhook always finds the row.
- **Status never regresses** (`src/lib/telephony/status.ts`). Terminal states are final. Side effects (timeline `call_logged`, first touch, missed-call task, campaign re-queue) run once, on the transition into a terminal state, so duplicate and out-of-order webhooks converge on one row.
- **First touch.** An outbound terminal call by the owner sets `lead_assignments.first_touch_at`: once through the 0072 recorder hook (because `call_logged` is recorded with the agent as actor), and once by explicit SQL.
- **Unknown inbound caller.** A stub contact and lead are created (`source = 'Inbound call'`), and `distributeLead` from lead capture runs inline, so the popup reaches the new owner without waiting for a job.
- **Popup and realtime.** The existing SSE bus is reused, with two new per-recipient events, `call.inbound` and `call.updated`, filtered client-side like notifications. No new channel was added.
- **Recordings** live in Supabase Storage (bucket env `SUPABASE_CALL_RECORDINGS_BUCKET`, default `call-recordings`, **must be private**) at `tenant/{tenant}/calls/{callId}.mp3`. They stream through `/api/calls/[id]/recording`, which checks access, logs the play to `call_recording_access` (append-only for `app_user`), and proxies a 60-second signed URL server-side with Range passed through. `serializeCall` is the only call shape that leaves the server; it drops `recording_url` and `recording_storage_key`, and a selftest checks this.
- **Access.** Reps see their own calls. Managers, admins and owners see every call in the workspace, because there is no team hierarchy yet (same decision as Prompt 1).
- **AI summaries are OFF by default** (`telephony_settings.ai_call_summary`). This matches the earlier "no cloud AI on documents" preference: no audio or transcript leaves the server unless an admin turns it on.
  - **STT:** the `Transcriber` interface ships with only `none` (`TELEPHONY_STT_PROVIDER`, default `none`). No cloud STT is wired, because choosing one means sending call audio to a third party and needs its own decision and docs check. With `none`, the summary step records `skipped`.
  - **Claude:** `claude-sonnet-5-5` (overridable with `ANTHROPIC_CALL_SUMMARY_MODEL`), structured output through `output_config.format`, zod-validated, one retry carrying the validation error, otherwise transcript only. Only the transcript and the call date are sent. A `follow_up_date` is dropped unless the transcript mentions a day. The installed SDK (0.94) has no types for server-side `fallbacks`, so no fallback is configured; a refusal stores the transcript only.
- **Dialer.** `claimNextItem` does `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)` with a 10-minute lock and re-checks DNC at claim time. An agent holding a claim gets the same item back. No-answer, busy and failed calls re-queue after `retry_gap_minutes` until `max_attempts`. The disposition closes answered items (Call back re-queues at the callback time). Progressive mode is driven by the agent's dialer page: after wrap-up (call ended and disposition saved) and while the agent is Available, it pulls and dials the next lead. The 1-minute cron releases stale claims and completes empty campaigns.
- **Disposition modal.** Mounted globally in the softphone bar. It has no close control. Skip is allowed only when the call never connected or lasted under 5 seconds (enforced server-side too). Inbound calls the agent never answered don't prompt a disposition; they get a callback task instead.
- **Missed-call task.** Tasks only have a `due_date` (no time), so "due in 15 minutes" goes into the task title and a `call_missed` notification.

### Not done / follow-ups

- **Migrations and DB tests not run.** 0073 is in the `build` chain and applies on the next deploy. `pnpm selftest:telephony-db` is written but was not run, because `DATABASE_URL` is production. It needs 0072 and 0073 applied.
- **No Call Details API reconciliation.** Exotel's docs recommend polling `GET /Calls/{sid}` when callbacks are late or lost. There is no reconciliation job yet, so a lost terminal webhook leaves the call `answered`/`ringing`. The softphone ignores active calls older than 3 hours.
- **Calling hours are a single daily window** (no per-weekday rules). The dashboard's "calls today" uses IST.
- **List-level DNC.** The deals and contacts list call buttons don't pre-check DNC (the server blocks on click). The deal page button shows the DNC state. The deals list rows have no call button yet. The contacts list got one, visible only when the softphone reports telephony as ready.
- **Outbound recording announcement** is a stored setting only; the audio must be configured in the Exotel call flow.
- **The sidebar has no Dialer entry.** It is reached from the softphone bar or `/dashboard/telephony/campaigns`.

## Prompt 3: Reporting and manager views (0074)

- **Reporting line instead of teams.**
  - Stored in `memberships.reports_to_user_id` and edited in Settings › Reporting lines (admins only; loops are refused).
  - `scopeUsers()` in `src/lib/reports/manager/scope.ts` is the only scoping path: owner/admin see the tenant, a manager sees self plus the recursive subtree, and member/viewer see only themselves.
  - **A manager with no reports falls back to the whole tenant** (`scope.fallback`, shown in the UI).
  - `teamId` query params are accepted and ignored.
- **Stage history extended, not duplicated.**
  - `deal_stage_history` gains `changed_by` (from `app.user_id`; `system` becomes NULL), `owner_id_at_change` and `source_id_at_change`.
  - These are written by the 0045 trigger, which 0074 replaces.
  - Old rows are backfilled with the deal's current owner and source.
- **Timezone.**
  - Reuses `organization_settings.timezone`. The default is now Asia/Kolkata.
  - **Existing `UTC` rows are rewritten to Asia/Kolkata.** Settings already let admins choose a timezone, so a workspace that deliberately chose UTC changes too. Review before deploying.
  - Every day bucket uses `AT TIME ZONE tz`; `localDay()` is the JavaScript twin.
- **One metric definition.**
  - The registry is `src/lib/reports/metrics.ts` (safe to import on the client).
  - The counter SQL is `manager/facts.ts`, used by both the rollup and the live "today" path.
  - The drill-downs reuse its row filters, so tiles and drill-downs match by construction.
  - Services live in `manager/services.ts`; routes and pages hold no metric SQL.
- **Rollup.**
  - `report_daily_rollup` enforces uniqueness through an expression index on `COALESCE(source_id, 0-uuid)`, because a primary key can't contain an expression.
  - A refresh deletes and re-inserts under a per-tenant advisory lock, with `ON CONFLICT DO UPDATE` as a backup.
  - A day is read from the rollup only if a finished backfill covers it and it is before today; otherwise it is computed live (`planSegments`).
  - The backfill commits its cursor in the same transaction as each day.
  - The first nightly run per tenant queues a 400-day backfill.
- **Funnel "reached"** means the lead entered the stage or any later funnel stage. This deviates from the prompt's "exists in history" so that skipped stages count and step conversion stays at or below 100%.
- **SLA** is computed live from `lead_assignments`. An assignment is due once its deadline has passed or it has been answered; it is met when the first touch is no later than the deadline.
- **Calls** are read from the 0073 `calls` table with raw SQL, guarded by `to_regclass`, so they read as 0 until the table exists.
- **Narrative.**
  - Model `claude-sonnet-5-5`, with structured outputs and effort `low`.
  - Server-side refusal fallback is on (`fallbacks: 'default'` plus the beta header). SDK 0.94 has no type for this field, so it is passed through a cast. If the API rejects it, the card shows "Narrative unavailable".
  - Only aggregates are sent; reps are pseudonymised, and a PII check runs before sending.
  - Every number in the output must be in the packet; bad JSON or a bad schema gets one retry.
  - Results are cached for 30 minutes (failures for 5 minutes).
  - Toggled by `organization_settings.report_narrative_enabled` together with `ai_enabled`.
- **Digests.**
  - An hourly cron sends the daily digest at 09:00 and the weekly one on Mondays at 09:00, in tenant time.
  - Saved-report schedules are stored as `{frequency, hour, weekday, recipients}` instead of a cron string.
  - Sends are idempotent through `report_digest_runs`: a send is claimed first, then sent. Failed sends are not retried.
  - Email goes through the existing provider factory; the console provider only logs.
  - WhatsApp is rendered only; there is no provider to send it.
- **Export.** CSV only, because there is no xlsx dependency. Keyset pages of 5,000 rows, a 100,000-row cap, formula-injection guarding, and every export recorded in `report_export_audit` (append-only for `app_user`).
- **Spend and ROI** are visible only in tenant scope.
- **Rollup attribution** is the owner at refresh time, and days older than 7 are frozen.
- **Tests.**
  - `scripts/selftest-reports.ts`: pure, 81 checks, included in `pnpm selftest`.
  - Not yet run, because they need a non-production database: `selftest:reports-db`, `seed:report-load` and `loadtest:reports`. The last two also need `ALLOW_LOAD_SEED=1`.

