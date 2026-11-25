# Field Meetings PR 1 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Field Meetings with no external services: full M1 schema, meeting API + state machine + risk engine
with notifications, manager day board and rep "My day" page, manual GPS check-in, site pinning, text MOM.

**Architecture:** Pure logic (geo, state machine, risk rules, KPIs) in `src/lib/field/*` with no DB access; a
service layer (`src/lib/field/{meetings,checkins,outcomes,day}.ts`) that is the only writer and runs inside
`tenantTransaction`; thin route handlers under `src/app/api/field/` and server actions both call the service.
External maps sit behind `MapsProvider` (Google when `MAPS_API_KEY` is set, otherwise an honest estimator).

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before writing routes/pages), Drizzle 0.45 +
postgres-js, Inngest 4, zod 4, React Query 5, Tailwind. Tests: `scripts/selftest-*.ts` run with tsx.

**Spec:** `docs/superpowers/specs/2026-11-25-field-meetings-design.md` (source requirement:
`docs/field-meetings/source-spec.md`). Read both before any task.

## Global Constraints

- Every table has `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` + RLS ENABLE/FORCE + the 4
  standard policies + `GRANT … TO app_user` (copy the DO-loop from `drizzle/0079_prospect_board.sql`).
- All DB access from app code goes through `tenantTransaction` inside `runWithTenantContext` / `runWithSystemContext`,
  and also filters `tenant_id` explicitly.
- Timestamps stored UTC (`timestamptz`); "a day" is the tenant-local day from `organization_settings.timezone`
  (default `Asia/Kolkata`).
- Defaults: `checkin_radius_m 300`, `no_checkin_grace_min 15`, `mom_due_hours 2`, tracking `09:00`–`19:00`,
  `tracking_interval_sec 120`, `location_provider 'none'`.
- Drive-time estimate without a key: haversine × 1.4 ÷ 25 km/h, flagged `estimate: true`.
- Accuracy warning threshold in the UI: worse than 100 m.
- Status changes only via `src/lib/field/state-machine.ts`.
- Reps can never set or move a site; pinning requires permission `pinFieldSites` (owner, admin, manager).
- No real Google or Claude calls from tests/seeds: tests inject a fake `MapsProvider`; scripts set
  `process.env.MAPS_API_KEY = ''` and `process.env.ANTHROPIC_API_KEY = ''` after dotenv loads.
- DB scripts run only against the Docker test DB (`.env.local`, port 15434). Check before running anything that writes.
- Inngest: one `step.run` for all tenants via `eachTenant`; add the new cron to `scripts/selftest-inngest-budget.ts`.
- New migration needs `drizzle/0081_field_meetings.sql`, `scripts/apply-0081.ts`, and `tsx scripts/apply-0081.ts`
  appended to the `build` chain in `package.json` before `next build`.

## Review Focus

1. **Tenant-day boundaries:** a meeting at 00:30 IST on 26 Nov is 19:00 UTC on 25 Nov; it must appear on the 26 Nov
   board and in the 26 Nov risk scan, not on 25 Nov. → Task 4 test `day view uses tenant-local day`.
2. **Double-tap check-in:** two concurrent check-in requests must yield one accepted `in` row and one
   `invalid_transition`, not two accepted rows. → Task 4 test `concurrent checkin accepts once` (row lock
   `SELECT … FOR UPDATE` on the meeting).
3. **Reschedule clears stale flags:** moving a meeting so the overlap disappears must remove `overlap` from both
   meetings at the next scan and from the live day view immediately. → Task 5 test `reschedule clears overlap`.
4. **Poor GPS accuracy inside the radius:** accuracy 2 000 m but computed distance 50 m is still verified (the spec
   checks distance only); the UI warns. → Task 4 test `low accuracy inside radius still verified`.
5. **Pasted Google Maps links in the wild:** `https://www.google.com/maps/place/X/@28.5355,77.3910,17z`,
   `https://maps.google.com/?q=28.5355,77.3910`, `28.5355, 77.3910`, and junk text. Junk must be rejected with a
   message, never saved as 0,0. → Task 2 test `parseSiteInput variants`.

---

### Task 1: Migration 0081 + Drizzle schema  ⛔ REVIEW GATE

**Files:**
- Create: `drizzle/0081_field_meetings.sql`, `scripts/apply-0081.ts` (copy `scripts/apply-0080.ts`, hash
  `manual-0081-field-meetings`, `created_at` = current epoch ms), `src/db/schema/field.ts`
- Modify: `src/db/schema/enums.ts` (new enums), `src/db/schema/companies.ts` (address cols),
  `src/db/schema/askmira.ts` (2 cols), `src/db/schema/index.ts` (export field), `package.json` (build chain)

**Interfaces:**
- Produces (Drizzle exports from `src/db/schema/field.ts`): `meetings`, `meetingCheckins`, `meetingOutcomes`,
  `calendarConnections`, `locationPings`, `locationViewAudit`, `tenantFieldSettings`, `geocodeCache`,
  `driveTimeCache`; types `Meeting`, `MeetingCheckin`, `MeetingOutcome`, `TenantFieldSettingsRow`.
  Enums in `enums.ts`: `meetingType`, `meetingStatus`, `meetingSource`, `geocodeStatus`, `checkinKind`,
  `locationSource`, `meetingSentiment`, `calendarProvider`, `locationProvider`, `identityMatchMethod`
  (values exactly as in the design doc "Schema" section).

- [ ] **Step 1: Write the SQL** exactly per the design's Schema section: enums (DO/EXCEPTION wrapped); `companies` add
  `address, city, state, postal_code, lat, lng, geocode_status`; tables `meetings` (incl. `title`, `notes`,
  `checked_in_at`, `checked_out_at`, `created_by`, `virtual_url`, `cancelled_at`, `cancel_reason`,
  `CHECK (end_at > start_at)`, unique `(tenant_id, source, external_event_id)`, indexes
  `(tenant_id, owner_id, start_at)`, `(tenant_id, start_at)`, `(tenant_id, deal_id)`), `meeting_checkins`
  (incl. `tenant_id`, `user_id`, `accepted`, `reject_reason`; index `(tenant_id, meeting_id, captured_at)`),
  `meeting_outcomes` (unique `meeting_id`, `ai_status text NOT NULL DEFAULT 'none'`), `calendar_connections`,
  `askmira_people` add `askmira_employee_id`, `match_method`, `location_pings` (`PARTITION BY RANGE (captured_at)`,
  PK `(id, captured_at)`, plus a `DO` block creating daily partitions `location_pings_YYYYMMDD` for today..+7),
  `location_view_audit`, `tenant_field_settings` (PK `tenant_id`), `geocode_cache`, `drive_time_cache`.
  FKs: `meetings.deal_id → deals ON DELETE SET NULL`, `company_id → companies SET NULL`, `contact_id → contacts SET
  NULL`, `owner_id → users`; child tables `meeting_id → meetings ON DELETE CASCADE`. RLS DO-loop over all 9 new tables.

- [ ] **Step 2: Mirror it in Drizzle** (`src/db/schema/field.ts`); `location_pings` modelled as a normal table
  (partitioning is SQL-only; add a comment).

- [ ] **Step 3: Apply to the test DB twice (idempotency)**
  Run: `grep DATABASE_URL .env.local` → must contain `:15434`. Then `pnpm tsx scripts/apply-0081.ts` twice.
  Expected: first run all `ok`; second run only `ok`/`already exists, skipping`, exit 0.

- [ ] **Step 4: Typecheck** — Run: `pnpm tsc --noEmit -p .` Expected: no errors.

- [ ] **Step 5: Commit** `feat(field): migration 0081 and schema for Field Meetings`

- [ ] **Step 6: STOP.** Show the user `drizzle/0081_field_meetings.sql` and wait for approval before Task 2.

---

### Task 2: Pure core — geo, site parsing, state machine, risk rules, KPIs

**Files:**
- Create: `src/lib/field/geo.ts`, `src/lib/field/state-machine.ts`, `src/lib/field/risk.ts`, `src/lib/field/kpis.ts`,
  `src/lib/field/types.ts`, `scripts/selftest-field.ts`
- Modify: `package.json` (`selftest` chain: append `&& tsx scripts/selftest-field.ts`; script `selftest:field`)

**Interfaces:**
- Produces:
  - `types.ts`: `type LatLng = { lat: number; lng: number }`; `type RiskReason = 'no_checkin' | 'travel_gap' |
    'overlap' | 'mom_missing'`; `type FieldActor = { tenantId: string; userId: string; role: MembershipRole }`;
    `class FieldError extends Error { code: 'not_found' | 'forbidden' | 'invalid_transition' | 'validation' |
    'outside_radius' }`.
  - `geo.ts`: `haversineMeters(a: LatLng, b: LatLng): number`; `estimateDriveMinutes(a: LatLng, b: LatLng): number`
    (ceil); `parseSiteInput(input: string): { kind: 'point'; point: LatLng } | { kind: 'short_url'; url: string } |
    null` (accepts `@lat,lng`, `?q=lat,lng`, `query=lat,lng`, bare `lat, lng`; rejects out-of-range and 0,0;
    `maps.app.goo.gl` / `goo.gl/maps` → `short_url`).
  - `state-machine.ts`: `MEETING_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]>`;
    `assertTransition(from: MeetingStatus, to: MeetingStatus, type: 'physical' | 'virtual'): void` throws
    `FieldError('invalid_transition')`.
  - `risk.ts`: `type RiskMeeting = { id: string; ownerId: string; type: 'physical'|'virtual'; status: MeetingStatus;
    startAt: Date; endAt: Date; site: LatLng | null; checkedOutAt: Date | null; hasOutcome: boolean }`;
    `type DriveFn = (a: LatLng, b: LatLng, departAt: Date) => Promise<{ minutes: number; estimate: boolean }>`;
    `type MeetingRisk = { reasons: RiskReason[]; travelGapMin: number | null; estDriveMin: number | null;
    estimate: boolean }`;
    `computeRisks(meetings: RiskMeeting[], now: Date, s: { graceMin: number; momDueHours: number }, drive: DriveFn):
    Promise<Map<string, MeetingRisk>>` (groups by owner, ignores cancelled; `travelGapMin`/`estDriveMin` set on the
    later meeting of each consecutive physical pair); `diffReasons(prev: string[], next: string[]): { added:
    RiskReason[]; removed: RiskReason[] }`.
  - `kpis.ts`: `computeKpis(rows: Array<{ status: MeetingStatus; atRisk: boolean; dealId: string | null;
    amountMinor: number | null; currency: string | null }>, tenantCurrency: string): { planned: number; checkedIn:
    number; atRisk: number; pipelineMinor: number; otherCurrencyDeals: number }` (planned = non-cancelled count;
    checkedIn = status ∈ checked_in/checked_out/mom_logged; pipeline sums each distinct dealId once).

- [ ] **Step 1: Write failing tests** in `scripts/selftest-field.ts` (pattern: `check(name, ok)` + exit code, as in
  `scripts/selftest-prospects.ts`; set `process.env.DATABASE_URL ??= 'postgres://selftest@127.0.0.1:1/never'`):
  - `haversine known pair`: Noida Sec 18 (28.5708, 77.3261) → Cyber Hub Gurugram (28.4950, 77.0895) ≈ 24.4 km ±0.3.
  - `radius`: point 500 m north of site → `haversineMeters > 300`; 50 m → `< 300`.
  - `drive estimate 12 km`: two points 12 km apart → `estimateDriveMinutes` in 39..42.
  - `parseSiteInput variants`: the 3 link forms + bare pair → points (28.5355, 77.391); `'near metro'`, `'0,0'`,
    `'95, 10'` → null; `https://maps.app.goo.gl/abc` → `short_url`.
  - `state machine`: every allowed edge in the design passes; `checked_out → checked_in`, `cancelled → planned`,
    `mom_logged → *`, and `planned → mom_logged` for physical throw; `planned → mom_logged` virtual passes.
  - `no_checkin at start+16`: physical planned meeting, start = now − 16 min, grace 15 → `['no_checkin']`;
    at start+14 → `[]`; virtual meeting at +16 → `[]`; checked_in → `[]`.
  - `overlap`: 10:00–11:00 and 10:30–11:30 same owner → both `overlap`; different owners → none; touching
    10:00–11:00 / 11:00–12:00 → none; one cancelled → none.
  - `travel_gap 12 km / 20 min`: A ends 11:00, B starts 11:20, 12 km apart, estimator drive → B has `travel_gap`,
    `travelGapMin 20`, `estDriveMin ≥ 39`; A has no `travel_gap`; a site-less meeting in between is skipped.
  - `mom_missing`: checkedOutAt = now − 2h01m, no outcome → flagged; with outcome → not; now − 1h59m → not.
  - `diffReasons`: prev `['overlap']`, next `['overlap','no_checkin']` → added `['no_checkin']`, removed `[]`.
  - `kpi distinct deals`: 3 meetings on deal X (₹1,00,000) + 1 on deal Y (₹50,000) + 1 USD deal → pipelineMinor =
    15000000, otherCurrencyDeals = 1.

- [ ] **Step 2: Run, expect FAIL** — `pnpm tsx scripts/selftest-field.ts` → module-not-found.

- [ ] **Step 3: Implement** the five files to the signatures above.

- [ ] **Step 4: Run, expect PASS** — same command, all checks ok, exit 0.

- [ ] **Step 5: Commit** `feat(field): geo, state machine, risk rules and KPI core`

---

### Task 3: Maps providers + caches + field settings

**Files:**
- Create: `src/lib/field/maps/types.ts`, `src/lib/field/maps/google.ts`, `src/lib/field/maps/estimate.ts`,
  `src/lib/field/maps/index.ts`, `src/lib/field/maps/cached.ts`, `src/lib/field/settings.ts`
- Test: `scripts/selftest-field.ts` (pure parts), `scripts/selftest-field-db.ts` (new; DB parts)

**Interfaces:**
- Consumes: `LatLng`, `estimateDriveMinutes`, `parseSiteInput` (Task 2); schema tables (Task 1).
- Produces:
  - `MapsProvider { name: string; geocode(address: string): Promise<{ status: 'ok' | 'failed' | 'pending'; point?:
    LatLng }>; reverseGeocode(p: LatLng): Promise<string>; driveMinutes(a: LatLng, b: LatLng, departAt: Date):
    Promise<{ minutes: number; estimate: boolean }>; resolveShortUrl(url: string): Promise<string | null> }`.
  - `getMapsProvider(): MapsProvider` — Google when `process.env.MAPS_API_KEY` non-empty, else Estimate.
    Estimate: geocode → `pending`; reverseGeocode → `"28.53550, 77.39100"`; drive → estimator, `estimate: true`;
    resolveShortUrl → `fetch(url, { redirect: 'manual' })` Location header (Google does the same).
  - `normalizeAddress(a: string): string` (lowercase, collapse whitespace/punctuation).
  - `geocodeCached(tx, tenantId: string, address: string, maps: MapsProvider)` → same shape as `geocode`;
    `driveMinutesCached(tx, tenantId, a, b, departAt, maps)` → `{ minutes, estimate }` (keys: lat/lng to 4 dp;
    `depart_bucket` = departAt floored to 30 min; rows older than 30 min ignored and overwritten).
  - `settings.ts`: `type FieldSettings = { locationProvider: 'askmira'|'native'|'none'; checkinRadiusM: number;
    graceMin: number; momDueHours: number; trackingStart: string; trackingEnd: string; trackingIntervalSec: number }`;
    `getFieldSettings(tx, tenantId): Promise<FieldSettings>` (defaults when no row);
    `saveFieldSettings(tx, tenantId, patch: Partial<Pick<FieldSettings,'checkinRadiusM'|'graceMin'|'momDueHours'|
    'trackingStart'|'trackingEnd'>>)` (zod: radius 50..5000, grace 0..120, momDue 1..72, HH:MM, start < end);
    `isWithinTrackingHours(s: FieldSettings, now: Date, tz: string): boolean`.

- [ ] **Step 1: Failing tests.** Pure: `google provider builds Distance Matrix URL with departure_time` (inject
  `fetch` stub; assert URL has `departure_time=<unix>` and `key=`; parses `duration_in_traffic`); `estimate geocode is
  pending, never a fake point`; `isWithinTrackingHours` 08:59 IST false / 09:00 true / 19:00 false.
  DB (`selftest-field-db.ts`, structure copied from `scripts/selftest-prospects-db.ts`: throwaway tenants, cleanup in
  `finally`, `process.env.MAPS_API_KEY = ''`): `geocodeCached hits provider once for same normalized address`
  (counting fake); `drive cache reused within 30 min, refetched after`; `settings defaults without row`;
  `saveFieldSettings rejects radius 10`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-field-db.ts`.
- [ ] **Step 3: Implement.** Google provider uses plain `fetch` (Geocoding API with `region=in`; Distance Matrix with
  `departure_time`, `traffic_model=best_guess`); `fetch` injectable via constructor for tests.
- [ ] **Step 4: Run both selftests, expect PASS.** Add `selftest:field-db` script to `package.json`.
- [ ] **Step 5: Commit** `feat(field): maps providers, caches and tenant field settings`

---

### Task 4: Meeting service — create/update/cancel/pin, check-in/out, walk-in, outcome, day view

**Files:**
- Create: `src/lib/field/scope.ts`, `src/lib/field/meetings.ts`, `src/lib/field/checkins.ts`,
  `src/lib/field/outcomes.ts`, `src/lib/field/day.ts`
- Modify: `src/lib/rbac.ts` (add `viewFieldTeam: ['owner','admin','manager']`, `manageFieldSettings:
  ['owner','admin']`, `pinFieldSites: ['owner','admin','manager']`), `src/lib/realtime/events.ts` (add
  `meeting.updated` `{ meetingId, ownerId }`)
- Test: `scripts/selftest-field-db.ts`

**Interfaces:**
- Consumes: Tasks 2–3; `scopeUsers`, `scopeIncludes` (`src/lib/reports/manager/scope.ts`); `recordActivity`
  (`src/lib/activity/recorder.ts`); `publishRealtimeEvent` (`src/lib/realtime/publisher.ts`).
- Produces (every function takes `actor: FieldActor` first and an optional last `deps: { maps?: MapsProvider; now?:
  () => Date }`; all throw `FieldError`):
  - `scope.ts`: `fieldUserScope(actor): Promise<ReportScope>`; `assertCanActFor(actor, ownerId): Promise<void>`.
  - `meetings.ts`: `createMeeting(actor, input: CreateMeetingInput): Promise<Meeting>` where `CreateMeetingInput =
    { title; type; startAt: Date; endAt: Date; ownerId?; dealId?; companyId?; contactId?; address?; virtualUrl?;
    notes? }` (address/coords default from company; geocode when address given and no copied coords);
    `updateMeeting(actor, id, patch: Partial<CreateMeetingInput>)` (re-geocode only when address changed and
    `geocode_status !== 'manual'`); `cancelMeeting(actor, id, reason?: string)`; `markEnRoute(actor, id)`;
    `pinMeetingSite(actor, id, input: string)` and `pinCompanySite(actor, companyId, input: string)` (require
    `pinFieldSites`; use `parseSiteInput`, resolve short URLs, set `geocode_status='manual'`).
  - `checkins.ts`: `checkIn(actor, id, pos: { lat; lng; accuracyM; overrideReason?: string }): Promise<{ checkin:
    MeetingCheckin; verified: boolean; distanceM: number | null }>` — owner only; locks the meeting row
    (`FOR UPDATE`); outside radius without override → inserts `accepted=false` row **in its own committed
    transaction**, then throws `FieldError('outside_radius')` carrying `{ distanceM, radiusM }`; no site →
    accepted, `verified=false`, `override_reason='site_not_geocoded'`;
    `checkOut(actor, id, pos: { lat; lng; accuracyM })` — sets `checked_out_at`, records `meeting_logged` on the deal
    (`metadata: { meetingId, verified }`) when `deal_id` set;
    `walkIn(actor, input: { lat; lng; accuracyM; title?; dealId?; companyId?; contactId?; notes? }): Promise<Meeting>`
    — one transaction: reverse geocode → insert meeting (`source 'walk_in'`, start now, end now+30 min, site = pos,
    `geocode_status 'manual'`, `needs_linking = !dealId`) → insert verified `in` row → status `checked_in`.
  - `outcomes.ts`: `saveOutcome(actor, id, input: { momText: string; sentiment?; nextSteps?: Array<{ action: string;
    dueDate?: string }>; checkOutAt?: { lat; lng; accuracyM } }): Promise<MeetingOutcome>` — `checkOutAt` given and
    status `checked_in` → checkOut first in the same transaction; upserts outcome; transitions to `mom_logged`;
    removes `mom_missing` from `at_risk_reasons`.
  - `day.ts`: `getDay(actor, q: { date: string; repId?: string; atRiskOnly?: boolean }): Promise<DayView>` where
    `DayView = { date; tz; kpis: ReturnType<typeof computeKpis>; reps: Array<{ userId; name; meetings:
    DayMeeting[] }>; scopeFallback: boolean }` and `DayMeeting` = meeting fields + `deal { id, name, amountMinor,
    currency, stage } | null`, `contact { id, name } | null`, `company { id, name } | null`, `checkins:
    MeetingCheckin[]`, `outcome: MeetingOutcome | null`, `risk: MeetingRisk` (live `computeRisks` via
    `driveMinutesCached`). Day = `[date 00:00, date+1 00:00)` in tenant tz.
  - Every write publishes `meeting.updated` in its transaction.

- [ ] **Step 1: Failing DB tests** in `scripts/selftest-field-db.ts` (tenant A with owner `o`, manager `m`, reps
  `r1` (reports to m), `r2` (reports to m), `r3` (no manager); tenant B with rep `b1`; fake maps provider):
  - `acceptance: 500 m reject then override` — site (28.5355, 77.3910); check-in 500 m north → throws
    `outside_radius` with distanceM 480..520; then with `overrideReason 'gate closed'` → `verified=false`;
    `meeting_checkins` has 2 rows (`accepted` false, true); status `checked_in`.
  - `inside radius verified`; `low accuracy inside radius still verified` (accuracyM 2000, 50 m → verified).
  - `no site → unverified site_not_geocoded`.
  - `concurrent checkin accepts once` — `Promise.allSettled` of two check-ins → exactly 1 fulfilled, 1
    `invalid_transition`; 1 accepted `in` row.
  - `non-owner cannot check in` (manager m on r1's meeting → `forbidden`).
  - `walk-in atomic` — run `walkIn` with a fake maps whose `reverseGeocode` throws → no meeting row, no checkin row;
    success path → meeting `walk_in`, `checked_in`, one verified row, `needs_linking` true.
  - `checkout logs meeting_logged once` with `metadata.verified`.
  - `outcome on checked_in with checkOutAt → mom_logged and clears mom_missing`; outcome on `planned` physical →
    `invalid_transition`; virtual planned → `mom_logged`.
  - `scoping`: r1 `getDay` sees only own; m sees r1+r2+self, not r3; o sees all; r1 `createMeeting` with
    `ownerId r2` → `forbidden`; m creating for r1 ok; tenant B actor never sees tenant A rows (RLS).
  - `rep cannot pin`; `manager pins via link → manual`; `address edit keeps manual pin`.
  - `day view uses tenant-local day` — meeting at 2026-11-26 00:30 IST appears for `date '2026-11-26'` only.
  - `acceptance: KPI distinct deal` — 3 meetings on one deal → `pipelineMinor` equals that deal once.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the five service files to the interfaces above.
- [ ] **Step 4: Run, expect PASS**; also `pnpm tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(field): meeting service, check-in/out, walk-in, outcomes, day view`

---

### Task 5: Risk scan cron + notifications

**Files:**
- Create: `src/lib/field/risk-scan.ts`, `src/lib/inngest/workflows/field.ts`
- Modify: `src/db/schema/notifications.ts` (`NOTIFICATION_TYPES` += `'field_meeting_at_risk'`),
  `src/lib/inngest/workflows/index.ts`, `src/app/api/inngest/route.ts` (register), `scripts/selftest-inngest-budget.ts`
  (expect cron `*/5 * * * *` for `field-risk-scan`), `src/lib/activity/format.ts` / notification renderer if types
  are switch-exhaustive.
- Test: `scripts/selftest-field-db.ts`

**Interfaces:**
- Consumes: `computeRisks`, `diffReasons` (Task 2); `getFieldSettings`, `isWithinTrackingHours`,
  `driveMinutesCached` (Task 3); `recordNotification`; `eachTenant`; `runWithSystemContext`.
- Produces: `scanTenantRisks(tenantId: string, deps?: { now?: () => Date; maps?: MapsProvider; ignoreHours?:
  boolean }): Promise<{ scanned: number; added: number; cleared: number; notified: number }>` — window: meetings
  with `start_at` ≥ now − 48 h and < end of tenant-local today, not cancelled; writes new `at_risk_reasons`; for each
  added reason notifies owner and owner's `reports_to_user_id` (if any), type `field_meeting_at_risk`, title e.g.
  `"No check-in: <title> (<rep name>)"`, entity `meeting`/id. Tenants scanned = those with ≥1 meeting in the window.
  Inngest function `fieldRiskScan` id `field-risk-scan`, cron `*/5 * * * *`, one `step.run('scan', …)` using
  `eachTenant`; skips tenants outside tracking hours.

- [ ] **Step 1: Failing tests:**
  - `acceptance: start+16 amber and exactly one manager notification` — r1 meeting start = now − 16 min; run
    `scanTenantRisks` twice → `at_risk_reasons = ['no_checkin']`; notifications: m has exactly 1, r1 has exactly 1.
  - `rep without manager notifies only the rep` (r3).
  - `acceptance: 12 km / 20 min travel_gap` persisted on the later meeting.
  - `reschedule clears overlap` — two overlapping meetings → scan → both flagged; `updateMeeting` moves one → scan →
    both cleared, no new notifications.
  - `flag clears after check-in`; `mom_missing flagged after 2h, cleared by outcome`.
  - `outside tracking hours skipped` (now 21:00 IST, `ignoreHours` false → `scanned 0`).
  - `cross-tenant`: scanning A never touches B's meetings.
  - Budget selftest passes: `pnpm tsx scripts/selftest-inngest-budget.ts`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `risk-scan.ts` and the Inngest wrapper (pattern: `src/lib/inngest/workflows/prospects.ts`
  maintenance cron).
- [ ] **Step 4: Run both selftests, expect PASS.**
- [ ] **Step 5: Commit** `feat(field): risk scan cron with once-per-flag notifications`

---

### Task 6: HTTP API

**Files:**
- Create: `src/app/api/field/_lib.ts`, `src/app/api/field/meetings/route.ts` (POST),
  `src/app/api/field/meetings/day/route.ts` (GET), `src/app/api/field/meetings/walk-in/route.ts` (POST),
  `src/app/api/field/meetings/[id]/route.ts` (PATCH), `.../[id]/cancel/route.ts`, `.../[id]/checkin/route.ts`,
  `.../[id]/checkout/route.ts`, `.../[id]/outcome/route.ts`, `.../[id]/en-route/route.ts`, `.../[id]/site/route.ts`
  (POST pin)
- Test: `scripts/selftest-field-api.ts` (pure, calls route `POST/GET` exports with a mocked session) — or extend the
  DB selftest if session mocking is impractical; pick one and note it in the commit.

**Interfaces:**
- Consumes: Task 4 service functions.
- Produces: `withFieldActor(req, fn: (actor: FieldActor) => Promise<unknown>): Promise<Response>` — `auth()` →
  401; tenant → 401; active membership → 403; runs `fn` in `runWithTenantContext`; maps `FieldError` codes:
  `not_found 404`, `forbidden 403`, `validation 400`, `invalid_transition 409`, `outside_radius 422` with body
  `{ error, code, distanceM, radiusM }`; success `200` JSON; `Cache-Control: no-store`. Bodies validated with zod
  (dates ISO strings → Date). `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`. Params in Next 16 are async — check
  the docs in `node_modules/next/dist/docs/` for route handler `params`.

- [ ] **Step 1: Failing tests:** checkin route 500 m → 422 body has `code 'outside_radius'`; with override → 200
  `verified false`; unauthenticated → 401; `GET day?date=bad` → 400; virtual outcome → 200.
- [ ] **Step 2: Run, expect FAIL.**  **Step 3: Implement.**  **Step 4: Run, expect PASS** + `pnpm lint`.
- [ ] **Step 5: Commit** `feat(field): HTTP API for meetings`

---

### Task 7: Rep page — `/dashboard/field/my-day`

**Files:**
- Create: `src/app/dashboard/field/my-day/page.tsx`, `src/app/dashboard/field/_components/meeting-card.tsx`,
  `.../checkin-button.tsx`, `.../mom-dialog.tsx`, `.../walk-in-dialog.tsx`, `.../meeting-form.tsx`,
  `src/app/dashboard/field/_lib/geolocate.ts`
- Modify: `src/app/dashboard/_components/nav-config.ts` ("My day" in MEMBER_NAV, MANAGER_NAV, ADMIN_NAV)

**Interfaces:**
- Consumes: API routes (Task 6) via `fetch`; `getDay` for the server-rendered first paint.
- Produces: `geolocate(): Promise<{ lat; lng; accuracyM }>` (`enableHighAccuracy: true`, timeout 15 s,
  `maximumAge 0`); `MeetingForm` (reused by Task 8) with props `{ defaultOwnerId; ownersInScope; onSaved }`.

- [ ] **Step 1: Build the page**: cards in time order with status chip and risk chips; Navigate =
  `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>` (or `encodeURIComponent(address)`), also calls
  `en-route`; Check in shows the notice "Your location is saved with this check-in" then geolocates; accuracy > 100 m
  shows "GPS accuracy is low (±N m) — move outdoors or retry" with Retry / Continue; 422 opens an override-reason
  prompt showing the distance; Check out; Log MOM (text, sentiment, optional next steps; "Check out & log MOM" when
  checked in); Log walk-in; New meeting. Header line: "Location tracking: off — manual check-in".
- [ ] **Step 2: Verify in the browser** (use the `run` skill; test DB; login rep@crm.test): create a meeting with a
  pinned site, check in from DevTools "Sensors" location 500 m away → override prompt → saved; check out; log MOM →
  card shows done. Mobile viewport 390×844 has no horizontal scroll.
- [ ] **Step 3: Commit** `feat(field): rep My day page`

---

### Task 8: Manager board — `/dashboard/field/today`

**Files:**
- Create: `src/app/dashboard/field/today/page.tsx`, `src/app/dashboard/field/_components/day-board.tsx`,
  `.../kpi-strip.tsx`, `.../swimlane.tsx`, `.../meeting-panel.tsx`, `.../board-filters.tsx`,
  `src/app/dashboard/field/_lib/timeline.ts`
- Modify: `nav-config.ts` ("Field day" in MANAGER_NAV and ADMIN_NAV); page guarded by `requirePermission('viewFieldTeam')`.

**Interfaces:**
- Consumes: `GET /api/field/meetings/day` (React Query, `refetchInterval: 30_000`; also invalidate on
  `useRealtimeEventOfType('meeting.updated')` when realtime is enabled); `MeetingForm` (Task 7).
- Produces: `timeline.ts`: `blockGeometry(startAt: Date, endAt: Date, tz: string, dayStartHour = 9, dayEndHour = 19):
  { leftPct: number; widthPct: number; clippedStart: boolean; clippedEnd: boolean }`; `blockColor(m: DayMeeting):
  'planned' | 'onsite' | 'done' | 'atrisk'` (at risk wins; onsite = arrived/checked_in; done = mom_logged).
  Add pure tests for both to `scripts/selftest-field.ts` (09:00–10:00 → left 0, width 10; 08:00–09:30 → clippedStart,
  width 5; risk precedence).

- [ ] **Step 1: Failing pure tests for `timeline.ts`; run → FAIL; implement; run → PASS.**
- [ ] **Step 2: Build the page:** filters (date, rep, only at risk) in URL search params; KPI strip (pipeline via
  `formatCompactTenantCurrency`, "+N other-currency deals" line); a lane per rep; blocks coloured per `blockColor`
  (amber for at risk); dashed connector between consecutive physical blocks labelled "~N min drive" ("est." when
  `estimate`), red when `travel_gap`; overlapping blocks stacked in sub-rows with red outline; click → side panel with
  deal (link), contact, company, check-in trail (accepted/rejected, distance, verified/override reason, time), MOM,
  risk reasons in plain words, and a "Pin site" field (Google Maps link or lat,lng → `POST …/[id]/site`); "New meeting" for a rep in scope; banner when `scopeFallback`.
- [ ] **Step 3: Verify in the browser** with seed data (Task 9) as manager@crm.test: overlap, travel gap and
  no-check-in rep render amber/red; panel opens; 30 s refresh picks up a check-in made in another tab.
- [ ] **Step 4: Commit** `feat(field): manager day board`

---

### Task 9: Company address + pin, Field settings page, seed, docs

**Files:**
- Modify: `src/app/dashboard/companies/actions.ts` (`updateCompanyAction` accepts address fields; geocode on change
  unless manual), company edit form component (address block; "Pin site" input visible with `pinFieldSites`),
  `src/app/dashboard/settings/_components/settings-nav.tsx` (item "Field meetings", `adminOnly`), `README.md`
- Create: `src/app/dashboard/settings/field/page.tsx` + `actions.ts` (radius, grace, MOM due hours, tracking hours;
  provider select disabled "available later"), `scripts/seed-field-meetings.ts`, `docs/field-meetings/ARCHITECTURE.md`
- Modify: `package.json` (`seed:field`)

**Interfaces:**
- Consumes: `pinCompanySite`, `saveFieldSettings`, `createMeeting`, `checkIn`.

- [ ] **Step 1: Company address + pin + settings page**; verify in browser: save address (no key → status pending),
  pin via a Google Maps link → coordinates shown; settings save and reject radius 10.
- [ ] **Step 2: Seed** `scripts/seed-field-meetings.ts [--reset]`: refuses unless `DATABASE_URL` contains `:15434`
  (or `SEED_ALLOW_REMOTE=1`); blanks `MAPS_API_KEY`/`ANTHROPIC_API_KEY`; 2 tenants `field-askmira` (settings row
  `location_provider 'askmira'`) and `field-solo` (`'none'`); each: 1 manager + 3 reps (`reports_to` manager),
  password `Test@12345`; companies with pinned sites — Noida Sec 62 (28.6270, 77.3727), Cyber City Gurugram (28.4950,
  77.0895), Okhla Ph III (28.5494, 77.2736); 3 meetings per rep today (tenant tz) incl. one overlap (rep 1),
  one tight travel gap Noida→Gurugram 20 min (rep 2), one meeting started 30 min ago with no check-in (rep 3); deals
  linked so one deal has 2 meetings. Prints logins.
  Run: `pnpm seed:field --reset` twice → idempotent; then `scanTenantRisks` via the board shows the three flags.
- [ ] **Step 3: Docs.** README "Field meetings" env section: `MAPS_API_KEY` (Geocoding now; Distance Matrix +
  Directions for PR 2), with GOOGLE_*/MS_GRAPH_*/ASKMIRA_* listed as "PR 2/3". `ARCHITECTURE.md`: state machine
  diagram (text), risk engine rules + scan window + notify-once, check-in verification rules, MapsProvider contract,
  site pinning rules, data-minimisation notes (what location is stored, where), retention placeholder for PR 3.
- [ ] **Step 4: Full verification** — `pnpm tsc --noEmit -p .`, `pnpm lint`, `pnpm tsx scripts/selftest-field.ts`,
  `pnpm selftest:field-db`, `pnpm tsx scripts/selftest-inngest-budget.ts`; all green.
- [ ] **Step 5: Commit** `feat(field): company sites, field settings, seed and docs`
