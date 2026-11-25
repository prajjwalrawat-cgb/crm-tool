# Field Meetings — design (PR 1 of 3: foundation)

Source spec: "Saleinx Field Meetings — Claude Code build prompt" (@Harry, 2026-11-24), milestones M1–M8, transcribed in
[docs/field-meetings/source-spec.md](../../field-meetings/source-spec.md). "Spec columns" below means the column list there.
This doc covers the whole module's schema and the scope of **PR 1**; PR 2 and PR 3 get their own short design notes when started.

## Intent

Sales reps in Saleinx tenants (mostly Delhi NCR) spend their day at customer sites. Managers today have no view of
where the day stands: which meetings happened, which reps are late or double-booked, which visits have no minutes.
Field Meetings gives:

- the **rep** a mobile day list with Navigate / Check in / Check out / Log MOM / Log walk-in, with GPS-verified check-in;
- the **manager** a live day board (timeline; map in PR 2) that flags risk early and notifies once;
- later, calendar import (PR 2), automatic location via AskMira or a native tracker, and voice MOM with AI extraction (PR 3).

Success for PR 1: a tenant with no external services configured can plan meetings, have reps check in/out from their
phones with honest verification, log text MOMs, and have managers see a day board with correct risk flags and exactly
one notification per new risk.

## Goals / non-goals / anti-goals

Goals (PR 1)
- Full M1 schema in one migration (reviewed before anything else builds on it).
- M2 API + risk engine + state machine; M3 manager and rep pages; manual check-in with browser geolocation.
- Text MOM (M2 `POST /outcome`) without AI.
- Unit + DB selftests and a seed for everything in PR 1.

Non-goals (PR 1) — later PRs
- Calendar sync, settings "needs linking" queue (PR 2 / M4).
- Map view, Directions polylines, live rep dot (PR 2 / M5).
- LocationProvider, AskMira geofences/webhook/visit feedback, native tracker, consent screen (PR 3 / M6).
- Voice MOM, transcription, Claude extraction, Today's Focus/AI-suggestions hand-off (PR 3 / M7).
- Today's Focus itself (separate project, designed after this).

Anti-goals (would be a failure even if it "works")
- A check-in shown as verified when the site has no coordinates or the rep was outside the radius without an override.
- Repeated notifications for the same flag on every cron run.
- Saleinx storing any raw location when the tenant's provider is AskMira (schema must make this enforceable later).
- Any automatic deal-stage change.
- Real Claude / Google calls from local or test runs.

## Constraints from the codebase

- Next.js 16 app; read `node_modules/next/dist/docs/` before writing route handlers/pages (AGENTS.md).
- Migrations are hand-written idempotent SQL `drizzle/NNNN_*.sql` + `scripts/apply-NNNN.ts`, appended to the `build`
  chain in `package.json`. Next number: **0081**.
- Tenant scoping: `tenant_id uuid` + RLS (ENABLE/FORCE + 4 policies on `app.tenant_id`, GRANT to `app_user`; copy the
  DO-loop from `drizzle/0079_prospect_board.sql`). Queries run inside `tenantTransaction` and also filter by tenant.
  Crons use `runWithSystemContext` + `eachTenant` (one step for all tenants — Inngest budget rule, guarded by
  `scripts/selftest-inngest-budget.ts`).
- No teams table. "Manager sees their team" = `scopeUsers()` in `src/lib/reports/manager/scope.ts`
  (recursive `memberships.reports_to_user_id`; manager without reports falls back to whole tenant).
- Tenant timezone: `organization_settings.timezone` (default `Asia/Kolkata`).
- Notifications: `recordNotification` (`src/lib/notifications/recorder.ts`); add types to `NOTIFICATION_TYPES`.
- Realtime is SSE over LISTEN/NOTIFY but **off by default**; polling every 30 s is the normal path.
- Secrets: `encryptJson/decryptJson` in `src/lib/telephony/crypto.ts` (KMS_KEY, AES-256-GCM).
- Companies have **no address**; contacts none either.
- AskMira user mapping already exists: `askmira_people (tenant_id, user_id, askmira_user_id)`.
- Tests are `scripts/selftest-*.ts` run with tsx (no jest/vitest). DB tests use the Docker test DB on :15434 via
  `.env.local`; `.env` is production — never run seeds/tests against it.
- No maps library or key exists yet; prerequisites (Maps key, Google/Azure apps, AskMira geofence API, DPDP review) are
  not done.

## Approaches considered

- **A. Three PRs (chosen by the user).** PR 1 foundation (M1 full schema, M2, M3, manual check-in, tests/seed for those);
  PR 2 calendar sync + map (M4, M5), shared with Today's Focus Phase 3; PR 3 location providers + voice MOM (M6, M7).
  Each ships when its own prerequisites land.
- B. One branch M1→M8. Nothing reaches production until all eight are done; M4–M7 would be built against mocks and
  reworked once real services exist.
- C. One PR per milestone. Smallest reviews, but M2 alone has no UI and M3 is useless without M2; more deploy/migration
  churn for little gain.

## Decisions

### Mapping the spec to this repo
| Spec | Here |
|---|---|
| `account_id` | `company_id` (companies table) |
| `team_id` filter | manager scope via `scopeUsers()`; optional `rep_id` filter within scope |
| `user_identity_links` | **extend `askmira_people`** with `askmira_employee_id`, `match_method` — no parallel table (my call) |
| "notification service" | `recordNotification` (in-app); email digest not in PR 1 |
| `/meetings/...` endpoints | `/api/field/meetings/...` route handlers + server actions, both calling one service layer |
| `/field/today`, `/field/my-day` | `/dashboard/field/today`, `/dashboard/field/my-day` |
| Today's Focus hand-off | PR 3: next steps become `tasks` (type `followup`); Today's Focus reads tasks |

### Schema (migration 0081, all of M1)

All tables carry `tenant_id` with standard RLS (child tables too, unlike the spec, so RLS works). Timestamps `timestamptz`, UTC.

**Enums:** `meeting_type (physical, virtual)`, `meeting_status (planned, en_route, arrived, checked_in, checked_out,
mom_logged, cancelled)`, `meeting_source (manual, gcal, outlook, walk_in)`, `geocode_status (pending, ok, failed,
manual)`, `checkin_kind (in, out)`, `location_source (askmira, native, browser)`, `meeting_sentiment (positive, neutral,
negative)`, `calendar_provider (google, microsoft)`, `location_provider (askmira, native, none)`, `identity_match_method
(sso, email, manual)`.

**companies** — add `address text, city text, state text, postal_code text, lat double precision, lng double precision,
geocode_status geocode_status`. Company edit form gets an address block. Meeting address defaults to this.

**meetings** — spec columns, plus (my calls):
- `title text not null` (UI needs a label; calendar events have one),
- `notes text`,
- `checked_in_at`, `checked_out_at timestamptz` (denormalised for risk queries),
- `created_by text`,
- `virtual_url text` (Meet/Teams link for virtual meetings),
- `cancelled_at`, `cancel_reason`.
- `sync_state text` (PR 2 fills it), `needs_linking bool default false`, `at_risk_reasons text[] default '{}'`.
- Unique `(tenant_id, source, external_event_id)`; indexes `(tenant_id, owner_id, start_at)`, `(tenant_id, start_at)`,
  `(tenant_id, deal_id)`.
- Check: `end_at > start_at`.

**meeting_checkins** — spec columns + `tenant_id`, `user_id`, `accepted bool` (rejected attempts are logged too —
"log every attempt"), `reject_reason text`. `distance_from_site_m` nullable (site without coordinates).

**meeting_outcomes** — spec columns + `tenant_id`, `ai_status text` (`none | pending | done | needs_review`; PR 3),
`updated_at`. One outcome per meeting (unique `meeting_id`); editing replaces it.

**calendar_connections** — spec columns as: `provider`, `account_email`, `refresh_token_enc`, `access_token_enc`,
`access_token_expires_at`, `scopes text[]`, `sync_token`, `delta_link`, `channel_id`, `channel_resource_id`,
`channel_expiry`, `last_synced_at`, `status`, `last_error`. Unique `(tenant_id, user_id, provider)`. Unused until PR 2;
designed to serve Today's Focus Phase 3 too (scopes column records whatever was granted).

**askmira_people** (existing) — add `askmira_employee_id text`, `match_method identity_match_method`.

**location_pings** — native provider only. `PARTITION BY RANGE (captured_at)`, daily partitions, PK `(id, captured_at)`.
Migration creates the parent + partitions for today..+7 days. PR 3 adds the Inngest job that creates future partitions
and drops ones older than 90 days. RLS on the parent.

**location_view_audit** — spec columns.

**tenant_field_settings** — one row per tenant (PK `tenant_id`): `location_provider default 'none'`,
`checkin_radius_m int default 300`, `no_checkin_grace_min int default 15`, `mom_due_hours int default 2`,
`tracking_start time default '09:00'`, `tracking_end time default '19:00'`, `tracking_interval_sec int default 120`,
`askmira_base_url text`, `askmira_service_token_enc text`, `askmira_webhook_secret_enc text`, `updated_at`.
Missing row = defaults.

**geocode_cache** — `(tenant_id, normalized_address)` PK, `lat`, `lng`, `status`, `provider`, `fetched_at`. Tenant
scoped because client addresses are tenant data (my call).

**drive_time_cache** — `(tenant_id, origin_key, dest_key, depart_bucket)` PK where keys are lat/lng rounded to 4 dp
and `depart_bucket` is departure time rounded to 30 min; `minutes`, `provider`, `fetched_at`. Rows older than 30 min
are ignored.

### Providers (all behind interfaces, mocks for tests)
`src/lib/field/maps/`: `MapsProvider { geocode(address), reverseGeocode(lat,lng), driveMinutes(origin, dest, departAt) }`.
- `GoogleMapsProvider` (plain fetch, Geocoding + Distance Matrix with `departure_time`) when `MAPS_API_KEY` is set.
- `EstimateMapsProvider` otherwise: geocode returns `pending` (no fake coordinates); reverse geocode returns
  "Lat, Lng" text; drive time = haversine × 1.4 road factor ÷ 25 km/h (12 km → ~40 min). Labelled "estimated" in the UI.
- `FakeMapsProvider` for tests (fixed table).

Geocoding runs server-side on create/update when the address changed; failure leaves `geocode_status='failed'`, never
blocks saving.

**Site coordinates (decided by the user: A + B).**
- A: a Google Maps key (Geocoding API to start) geocodes company and meeting addresses automatically. The key is being
  arranged; until it exists, the Estimate provider applies.
- B: **managers, admins and owners** can pin a site on a company or a meeting by pasting a Google Maps link
  (`@lat,lng`, `?q=lat,lng`, `/place/.../@lat,lng` forms parsed; short `maps.app.goo.gl` links are resolved
  server-side by following the redirect) or raw `lat, lng`. Sets `geocode_status='manual'`; a later address edit does
  **not** overwrite a manual pin unless the pin is cleared. Permission `pinFieldSites` (owner, admin, manager).
- **Reps can never set or move a site.** Walk-ins are the only case where the rep's position becomes the site, and that
  meeting's check-in is marked `verified=true` only because it is the same position (shown as "walk-in" in the trail).
- A meeting created for a company copies the company's address and coordinates (including manual pins).

### State machine (`src/lib/field/state-machine.ts`, the only writer of `status`)
```
planned   → en_route | arrived | checked_in | cancelled | mom_logged*
en_route  → planned | arrived | checked_in | cancelled
arrived   → checked_in | cancelled
checked_in→ checked_out
checked_out → mom_logged
mom_logged, cancelled → (terminal)
* planned → mom_logged only for type='virtual'
```
Invalid transitions throw `InvalidTransitionError` → 409. PR 1 sets `en_route` when the rep taps Navigate; `arrived`
comes from geofences in PR 3. Logging a MOM on a physical meeting that is still `checked_in` is offered in the UI as
"Check out & log MOM" (two transitions, one transaction) (my call).

### Check-in / check-out / walk-in
- `POST /api/field/meetings/:id/checkin {lat, lng, accuracy, override_reason?}`: haversine to site.
  - Site has coordinates and distance ≤ `checkin_radius_m` → accepted, `verified=true`.
  - Outside radius, no override → **rejected (422)**, attempt row saved with `accepted=false`.
  - Outside radius with override → accepted, `verified=false`, `override_reason` saved.
  - Site has no coordinates → accepted, `verified=false`, `override_reason='site_not_geocoded'`, distance null.
  - `location_source='browser'` in PR 1. Only the meeting owner can check in.
- Check-out records a `kind='out'` row (same distance computation, never rejected) and sets `checked_out_at`.
- Walk-in: one transaction creates meeting (`source='walk_in'`, start=now, end=now+30 min default, address from reverse
  geocode, site lat/lng = rep position) + accepted verified check-in. Deal/company optional; `needs_linking=true` if no
  deal.
- On check-out, record a `meeting_logged` activity on the linked deal (existing `recordActivity`, metadata
  `{meetingId, verified}`), so deal scoring, stage gates, `meetings_held` and Today's Focus see it (my call). Unverified
  check-outs count too: the deal page's manual "Log meeting" already counts unverified, so this does not weaken gates.
  No double count: the field flow records exactly one activity per meeting; manual "Log meeting" is unchanged.
- Existing meeting **tasks** (`tasks.type='meeting'`) stay separate: not migrated, not shown on the board (my call).
- Location data and privacy: `meeting_checkins` lat/lng is "derived check-in data", which the spec allows in every
  provider mode; only `location_pings` is forbidden for AskMira tenants (enforced in PR 3). The check-in button shows a
  one-line notice "Your location is saved with this check-in" before the browser prompt (my call).

### Risk engine (`src/lib/field/risk.ts`, pure functions, used by both the day API and the cron)
Rules over one owner's non-cancelled meetings for the tenant-local day:
- `no_checkin`: physical, status ∈ {planned, en_route, arrived}, now > start + grace.
- `overlap`: time ranges intersect → both meetings flagged.
- `travel_gap`: consecutive physical meetings with coordinates; `driveMinutes(prev.site, next.site, prev.end) > next.start − prev.end` → flagged on the **later** meeting.
- `mom_missing`: `checked_out_at + mom_due_hours < now` and no outcome.

Cron `field-risk-scan` (`*/5 * * * *` UTC, my call; handler skips tenants outside their tracking hours in tenant tz;
one `step.run` over all tenants via `eachTenant`; added to the budget selftest). Scan window: meetings starting in the
last 48 h through the end of today (tenant-local), so a `mom_missing` that falls due after hours (checkout at 17:30) or
a no-check-in near 19:00 is flagged and notified at the next in-hours run (my call). For each meeting it diffs new reasons vs
stored `at_risk_reasons`, writes the new set, and for each **newly added** reason sends one `field_meeting_at_risk`
notification to the owner and to the owner's `reports_to_user_id` (if set; nobody else — my call). Cleared reasons are
just removed. Day API computes reasons live with the same function so the board is current between cron runs.

Inngest cost note: `*/5` = 288 runs/day regardless of tenants. Alternative if that matters: limit to `*/5 2-15 * * *` UTC
(covers IST working hours only).

### API (`src/app/api/field/...`, session-authenticated, all through `src/lib/field/service.ts`)
- `GET /meetings/day?date=YYYY-MM-DD&rep_id=&at_risk_only=` → `{ date, tz, kpis, reps: [{ user, meetings: [...] }] }`;
  each meeting joined with deal (name, amount, stage), contact, company, check-in trail, outcome, `travel_gap_min`,
  `est_drive_min` (+ `estimate: bool`), `at_risk_reasons`.
  KPIs: planned, checked in, at risk, **pipeline in play = sum of amount over DISTINCT deal ids**. There is no FX
  conversion helper in the repo, so the total is in the tenant's currency and deals in other currencies are listed
  as "+ N deals in other currencies" rather than summed (my call).
- `POST /meetings`, `PATCH /meetings/:id`, `POST /meetings/:id/cancel`, `POST /meetings/:id/checkin`,
  `POST /meetings/:id/checkout`, `POST /meetings/:id/outcome {mom_text, next_steps?, sentiment?}`, `POST /meetings/walk-in`,
  `POST /meetings/:id/en-route`.
- Scoping: member → own; manager → `scopeUsers`; owner/admin → tenant. Creating/editing for another rep requires the
  rep to be in scope. New RBAC permissions: `viewFieldTeam` (owner, admin, manager), `manageFieldSettings` (owner, admin).
- Realtime: publish `meeting.updated` on every write (used only when realtime is enabled).

### UI
- **`/dashboard/field/today`** (manager/admin): filters (date, rep, only at risk) in the URL; KPI strip; swimlane per rep
  on a 09:00–19:00 grid (hand-built CSS grid, no new library); blocks coloured planned (grey) / on site (blue) / done
  with MOM (green) / at risk (amber); cancelled hidden; dashed travel segments between consecutive blocks labelled with
  drive minutes; overlapping blocks stacked with a red outline. Click → side panel: deal, contact, check-in trail
  (accepted and rejected attempts, distance, verified/override), MOM, risk reasons. Refresh: React Query 30 s polling,
  plus realtime when enabled. Blocks outside 09:00–19:00 are clamped to the edge with a marker.
- **`/dashboard/field/my-day`** (everyone): time-ordered cards; Navigate (Google Maps deep link
  `https://www.google.com/maps/dir/?api=1&destination=lat,lng` or address); Check in / Check out with
  `enableHighAccuracy`, warning when accuracy > 100 m, override-reason prompt on 422; Log MOM (text); Log walk-in;
  New meeting. Tracking state shows "Location tracking: off (manual check-in)" in PR 1.
- **New meeting form**: title, type, start/end, deal/company/contact pickers (existing search components), address
  prefilled from the company, owner (self, or a rep in scope for managers).
- **Settings → Field meetings** (owner/admin): radius, grace, MOM due hours, tracking hours. Provider selector is shown
  disabled with "available later" (my call).
- **Company form**: address fields.
- Nav: "Field day" in MANAGER_NAV and ADMIN_NAV; "My day" in MEMBER_NAV (and managers too).

### Tests, seed, docs (PR 1 share of M8)
- `scripts/selftest-field.ts` (pure): haversine/radius, each risk rule, state machine, drive estimate, KPI distinct sum.
- `scripts/selftest-field-db.ts` (test DB): check-in reject then override (2 rows, verified=false); walk-in atomicity
  (forced failure leaves nothing); permission scoping (rep/manager/admin); cross-tenant RLS; cron notifies exactly once
  across two runs and clears the flag when resolved; mom_missing cleared by outcome; acceptance scenarios
  (500 m reject/override, start+16 min amber + one manager notification, 12 km / 20 min travel gap, KPI distinct deals).
- `scripts/seed-field-meetings.ts`: 2 tenants (one marked AskMira-connected via settings, one Saleinx-only), 1 manager +
  3 reps each with reporting lines, 3 meetings per rep in Noida / Gurugram / Okhla with real coordinates
  (`geocode_status='manual'`), including one overlap, one tight travel gap, one past-due no-check-in. Refuses to run
  unless the DB is on :15434.
- README: `MAPS_API_KEY` (others listed as "PR 2/3"). `docs/field-meetings/ARCHITECTURE.md`: state machine, risk engine,
  provider interfaces, data-minimisation notes; extended by later PRs.

### Review gate
After the migration (0081) and Drizzle schema are written and applied to the test DB, stop and show the migration for
review before writing the service layer.

## Left to the builder
Component structure, exact colours, query shapes, file layout inside `src/lib/field/`, server action vs fetch per
screen, error copy.
