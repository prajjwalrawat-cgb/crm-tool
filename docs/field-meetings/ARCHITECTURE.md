# Field meetings: architecture (PR 1)

Scope of this document: what PR 1 builds. Calendar sync and the map are PR 2; location providers and voice MOM are PR 3. Where a later PR will change a contract, it says so. Product intent is in `docs/field-meetings/source-spec.md` and `docs/superpowers/specs/2026-11-25-field-meetings-design.md`.

Code lives in `src/lib/field/`. Every service function takes a `FieldActor { tenantId, userId, role }` and runs inside that tenant's RLS context.

## 1. Meeting state machine

Source of truth: `MEETING_TRANSITIONS` in `src/lib/field/state-machine.ts`.

```
planned --> en_route --> arrived --> checked_in --> checked_out --> mom_logged
   |  ^__________|                           (terminal)
   |  (undo Navigate)
   +--> arrived, checked_in      (planned and en_route may skip ahead)
   +--> mom_logged              (planned, virtual meetings only: no visit to check in to)
   +--> cancelled               (from planned, en_route, arrived; terminal)
```

As a table:

| From | To |
|---|---|
| planned | en_route, arrived, checked_in, cancelled, mom_logged (virtual only) |
| en_route | planned, arrived, checked_in, cancelled |
| arrived | checked_in, cancelled |
| checked_in | checked_out |
| checked_out | mom_logged |
| mom_logged, cancelled | none |

Rules worth knowing:

- Anything else throws `FieldError('invalid_transition')`. Double taps are serialised by a row lock (`lockOwnedMeeting`): the second caller re-reads the new status and fails the transition.
- `markEnRoute` is idempotent: en_route, arrived and checked_in are no-ops.
- `saveOutcome` moves a meeting to `mom_logged`. It can check out in the same transaction when the meeting is still `checked_in`. Editing an existing MOM replaces it without another transition.
- What a status lets you change on a meeting (`buildUpdate` in `meetings.ts`): planned and en_route, anything; arrived, checked_in and checked_out, title, notes and deal/company/contact links; mom_logged, notes only; cancelled, nothing.
- "Needs a deal": `needs_linking` is true whenever a meeting has no deal. `createMeeting` sets it for a manual meeting created without a deal (walk-ins already did); an edit that links a deal clears it, one that removes the deal sets it again. The My day card and the manager panel show a "Needs a deal" chip; the board block's aria-label says "needs a deal".
- Only the meeting owner can check in, check out, mark en route or log the MOM. Managers act for reps through create/update/cancel/pin only.
- UI for edit and cancel (`meeting-actions.tsx`, gates in `_lib/meeting-edit.ts` mirror the rules above): the rep's My day card offers Edit and Cancel meeting on the owner's planned and en_route meetings; the manager board panel offers Edit on any non-cancelled in-scope meeting (fields the status no longer allows are read-only) and Cancel on planned, en_route and arrived. Viewers see neither. Edit sends only changed fields (PATCH); server errors are shown as-is, a 409 with a "refresh and try again" hint.

## 2. Risk engine

Pure rules in `risk.ts` (`computeRisks`). Reasons per meeting, over one owner's non-cancelled meetings:

| Reason | Rule |
|---|---|
| `no_checkin` | physical, status in planned / en_route / arrived, and `now > start + grace` (default 15 min) |
| `overlap` | two of the owner's meetings intersect in time; both are flagged |
| `travel_gap` | consecutive physical meetings that both have coordinates, and `drive(prev.site, next.site, prev.end) > next.start - prev.end`. Flagged on the later meeting. An overlapping pair gets `overlap` only, no negative gap. |
| `mom_missing` | `checked_out_at + mom_due_hours < now` (default 2 h) and no outcome row. A virtual meeting is never checked out, so while it is still `planned` it is due from `end_at + mom_due_hours`. |

Drive time comes from `driveMinutesCached`: a 30-minute cache bucket keyed on 4-decimal coordinates, per tenant. Estimates (no `MAPS_API_KEY`, or a Google failure) are never cached, so they cannot mask a later real key, and the UI marks them as estimates.

### The scan (`risk-scan.ts`, `scanTenantRisks`)

Cron `field-risk-scan` (`*/5 * * * *`, `src/lib/inngest/workflows/field.ts`) picks tenants with any non-cancelled meeting starting in `[now - 48 h, now + 24 h]` and scans each under its own system context. The tenant pick reads FORCE-RLS `meetings` with the raw `db` and no tenant context: it relies on the connection role bypassing RLS (superuser / BYPASSRLS, the assumption of migration 0004 and the 0045 backfill). Under a non-bypass role it would find no tenants. A tenant outside its tracking hours (tenant time zone) is skipped, unless the caller passes `ignoreHours` (the seed does).

Window: meetings starting from 48 h ago to the end of today in the tenant's time zone, so a `mom_missing` that falls due after hours is flagged at the next in-hours run.

Three phases, with no row lock held across a network call:

1. One short read transaction: org time zone, field settings, the meetings, outcomes, reporting lines, names. Each meeting's `updated_at` is also read as text, because a JS `Date` cannot hold its microseconds.
2. Compute, with no transaction open. Meetings are grouped by tenant-local day, so pairing (overlap and travel gap) never crosses midnight. Each drive lookup runs in its own short, sequential transaction (cache read, provider call, cache write). Pairs whose later meeting has already started are frozen (`skipDrive`): no re-pricing of past travel, and a stored `travel_gap` on a started meeting is kept.
3. One short write transaction applying each change as a compare-and-swap: the update matches only if status, start, end, `updated_at` (as exact text) and the stored `at_risk_reasons` are all what phase 1 saw. A concurrent edit or scan makes the swap miss and the next run picks it up. Notifications are sent only for rows the swap actually changed. Edits to the other meeting of a pair during a scan are not detected; the next scan corrects them.

Notify-once: for each reason newly added to a meeting, one `field_meeting_at_risk` notification goes to the owner and to the owner's `reports_to_user_id` (nobody else). A reason that clears and later returns is a new appearance. A second run with unchanged inputs writes and notifies nothing.

Check-in clears `no_checkin` and saving the MOM clears `mom_missing` immediately (`array_remove`), without waiting for a scan.

The Field day API (`getDay`) runs the same `computeRisks` live, so the board is current between scans. It persists no risk, and it never calls the maps provider with a transaction open:

1. One read transaction: meetings, check-ins, outcomes, names, settings, and the cached drive times for every pair the risk rules will ask about (a pure collecting pass of `computeRisks` lists them; one batched cache query).
2. No transaction: provider calls for the cache misses, at most 4 in parallel. A pair whose later meeting has already started is never priced: it uses the cache, or gets no drive figure. A `travel_gap` the scan stored on a started meeting is kept on the board.
3. One short write transaction storing the real (non-estimate) answers. A failed cache write is logged and does not fail the board.

A second load within the cache TTL makes no provider calls.

## 3. Check-in verification

`checkins.ts`. Every attempt is logged in `meeting_checkins`, accepted or not.

1. The caller must own the meeting, and the meeting must be able to move to `checked_in`.
2. Time window: check-in is open from `checkin_opens_before_min` before the start to `checkin_closes_after_min` after the end (tenant settings, defaults 120 and 240, each 0 to 1440; both ends inclusive; 0 / 0 = only during the meeting). The rule lives in one pure helper, `checkinWindow` / `checkinWindowState` in `checkin-window.ts`, used by `checkIn` and by `getDay`, which exposes `checkinOpensAt` / `checkinClosesAt` (ISO) on every `DayMeeting` so the UI never re-derives it. Outside the window the attempt is committed (`accepted = false`, `reject_reason = 'outside_window'`, with the submitted position and distance), then `FieldError('outside_window')` carries `opensAt` and `closesAt`; the route answers 422 `{ error, code, opensAt, closesAt }`. This check runs before the distance check, and an override reason does not bypass it. Walk-ins, check-out and outcomes are not affected. The My day card disables Check in with "Check-in opens at 9:30 am" / "Check-in closed at 4:30 pm" (tenant time zone, re-evaluated each minute) and shows the same copy on a 422 `outside_window`.
3. Radius = the company's `checkin_radius_m` when the meeting's company has one, else the tenant's `checkin_radius_m` (default 300 m). Both are 50 to 5000 m (DB CHECKs).
4. Distance = haversine between the browser position and the meeting's site (`meetings.lat/lng`, copied from the company or pinned when the meeting was created or last re-sited).
5. Outcomes (inside the window):
   - Within the radius: accepted, `verified = true`.
   - Outside the radius, no override reason: rejected. The attempt is committed (`accepted = false`, `reject_reason = 'outside_radius'`), then `FieldError('outside_radius')` carries `distanceM` and `radiusM`.
   - Outside the radius with an override reason: accepted, `verified = false`, reason stored.
   - Site has no coordinates: accepted, `verified = false`, `override_reason = 'site_not_geocoded'`, distance null.
6. GPS accuracy is stored with the attempt but does not change the verdict.
7. Late check-in: `lateBy(meeting, firstAcceptedCheckinAt, graceMin)` in `late.ts` (pure) gives the minutes from `start_at` to the first accepted `kind = 'in'` check-in when it came after start + `no_checkin_grace_min`; null when on time (start + grace exactly is on time), not checked in, a walk-in, or virtual. `getDay` exposes it as `DayMeeting.lateMin`. The rep card and the manager panel (header chip and the check-in trail) show "Late check-in · N min late" with a clock icon; the board block's aria-label says "late check-in, N min late". No schema change.
8. Check-out records a `kind = 'out'` row with the same distance and verified computation, and is never rejected. On check-out with a linked deal, one `meeting_logged` activity is recorded on the deal, carrying the check-in's verdict.
9. Walk-in: one transaction creates the meeting (`source = 'walk_in'`, start now, 30 minutes, address from reverse geocode, site = the rep's position, `geocode_status = 'manual'`, `site_source = 'walk_in'`) and a verified check-in. `needs_linking` is set when there is no deal. The reverse geocode happens before any insert, so a provider failure leaves nothing behind.

## 4. MapsProvider contract

`src/lib/field/maps/types.ts`.

```ts
interface MapsProvider {
  name: string;
  geocode(address: string): Promise<{ status: 'ok' | 'failed' | 'pending'; point?: LatLng }>;
  reverseGeocode(p: LatLng): Promise<string>;                       // falls back to "lat, lng"
  driveMinutes(a: LatLng, b: LatLng, departAt: Date): Promise<{ minutes: number; estimate: boolean }>;
  resolveShortUrl(url: string): Promise<string | null>;
}
```

`getMapsProvider()` returns `GoogleProvider` when `MAPS_API_KEY` is set, else `EstimateProvider`.

- `geocode`: `ok` and `failed` are verdicts about the address and are cached per tenant by normalised address (`geocode_cache`). `pending` means "no answer yet" (no key, timeout, quota, denied) and is never cached. `EstimateProvider` always answers `pending`; it never invents coordinates.
- `driveMinutes`: Google Distance Matrix with traffic (departure time clamped to now). On any failure, or without a key, a straight-line estimate (distance x 1.4 at 25 km/h, rounded up) with `estimate: true`.
- `resolveShortUrl`: follows exactly one redirect hop and returns the `Location`, guarded against SSRF. The input must be https and its host must be one of `goo.gl`, `maps.app.goo.gl`, `g.co`, or a Google host (`google.com`, `www.google.com`, `maps.google.com`, `google.co.in`, `www.google.co.in`, `maps.google.co.in`) with a path starting `/maps`. The redirect target must be https and on a Google host. Timeout 3 s, redirects are not auto-followed. Anything else returns `null`.
- Calls are bounded (4 s Google, 3 s redirect).

Pool rule: scope checks and all network calls (geocode, short-link resolution) happen before a write transaction opens. The planning step reads the geocode cache in a short read transaction (`lookupPre`), the network call runs with no transaction (`fetchPre`), and the write transaction only stores the verdict and applies it (`siteFor`, `geocodeStore`).

## 5. Site pinning

Where a meeting's coordinates come from (`site.ts`, `siteFor`):

1. The meeting's own address is the company's address (or empty) and the company has coordinates: copy the company's point and status, manual pins included. No geocoding.
2. Otherwise the address is geocoded (cache, then provider). `ok` gives coordinates; `failed` and `pending` leave them null and record the status.
3. Virtual meetings have no site.

"The company's address" is one line everywhere: `companyGeocodeLine(company)` in `site.ts` = address, city, state, postal code. The company form geocodes that line and a meeting with a blank address inherits it (and geocodes it when the company has no point). A meeting address equal to the street line alone (older rows) also counts as the company's.

### Site source and the rep-entered marker

`meetings.site_source` (CHECK `company | address | pin | walk_in`, null for virtual meetings and for a physical meeting with neither address nor company) records where the point comes from, and `meetings.site_rep_entered` whether the meeting's own address was typed by someone without `pinFieldSites` (a rep). Every site change sets them:

| Change | site_source | site_rep_entered |
|---|---|---|
| Address blank or equal to the company's line (`isCompanyAddress`), create or edit | company | false |
| Own typed address (geocoded before the write transaction; `pending` without a key) | address | actor lacks `pinFieldSites` |
| Manager pin (`pinMeetingSite`) | pin | false |
| Walk-in | walk_in | false |
| Company pin or company re-geocode propagation | company | false |
| Type changed to virtual | null | false |

An address equal to the company's line always uses the company's site, manual pins and coordinates included, with no geocoding (so it works with no Maps key); the company's line without a company point yet is still `company` and is geocoded. The comparison is `isCompanyAddress` in `site-line.ts` (trimmed equality with the full line, or the street line older rows carry), shared by the server and the meeting form. Migration 0081 backfills physical rows that have no `site_source` (idempotent: only `site_source IS NULL`): walk-ins, then inherited addresses whose point is not their own pin, then other manual points as `pin`, then own addresses (rep-entered when the creator is a member or viewer).

The manager board block (icon + "rep-entered address" text, and in its aria-label) and the panel (chip, and "The rep typed this address; check-ins are verified against it.") mark `site_rep_entered`. A manager pin clears it. The rep card and the panel say "Site not located: check-ins here are unverified." for a physical meeting with no coordinates, so the manager knows to pin.

Re-siting on edit (`updateMeeting`, planned / en_route, not the meeting's own point, i.e. `site_source` not `pin` or `walk_in`; a point copied from a pinned company is not the meeting's own, so editing such a meeting's address re-sites it): an address change geocodes the new address. A company change or clear, or a type change to physical, re-sites too: a meeting whose address was inherited from the old company (blank, or that company's line) follows the new company, or has no site when the company was cleared; a meeting with its own address keeps it and geocodes it. The old company's point is never kept.

Pins:

- A pin is a Google Maps link (short links resolved server-side) or `lat, lng`; addresses are not pins. `resolvePin` accepts `!3d<lat>!4d<lng>` (the place, in /place/ URLs; preferred over the camera's `@lat,lng`), `@lat,lng`, `?q=lat,lng` and `?query=lat,lng` (comma may be `%2C`) and a bare pair; (0, 0) and out-of-range values are rejected. Input over 2000 characters is rejected. An `http://` short link is upgraded to https before resolving; the resolver's allowlist is unchanged.
- Only owner, admin and manager (`pinFieldSites`) can pin. Reps can never set or move a site.
- Meeting pin (`pinMeetingSite`): sets the point and `geocode_status = 'manual'`. Allowed while the meeting is planned, en_route or arrived. Virtual meetings cannot be pinned.
- Add and Edit company share one site block (`site-address-fieldset.tsx`): address, city, state and postal code for anyone who can create companies; Site pin and Check-in radius only with `pinFieldSites` (the actions ignore those fields from anyone else). Add company resolves a pin before any write (a bad pin creates nothing), otherwise geocodes `companyGeocodeLine` before the insert (`lookupPre` / `fetchPre`, then `companySiteFromPre` inside the insert transaction: `pending` without `MAPS_API_KEY`, never invented coordinates), and applies a pin and its radius through `pinCompanySite` once the company exists. Edit company uses the same `readSiteForm` and `companySiteFromPre`.
- Company pin (`pinCompanySite`, used by the company forms): sets `lat`, `lng`, `geocode_status = 'manual'` and optionally the per-company `checkin_radius_m` (undefined keeps it, null clears it). It then moves that company's physical meetings that have not started (planned, en_route, arrived) to the new point when they use the company's site (`site_source` `company` or unclassified): never a meeting's own pin, its own typed address, or a walk-in. It fills a blank meeting address from the company's.
- Company address edits (address, city, state, postal code) re-geocode unless the company is `manual`. A company that still has no point is retried on its next save. A successful re-geocode (`propagateCompanyPoint`, same write transaction) gives the new point to that company's not-started physical meetings that have no site yet (`lat IS NULL`), no manual pin, and an inherited address (blank, or the company's old or new line); their address becomes the new line. Meetings that already have a site, or carry their own address, are not moved: only a pin moves sited meetings. A company with a manual pin keeps it when its address changes.
- Geocode status in words on the company form: ok "Located", manual "Pinned manually", pending "Not located yet", failed "Couldn't locate".

### Meeting form pickers

Deal, company and contact in the meeting form (New meeting, Edit, and the walk-in dialog) are searchable dropdowns (`entity-search-select.tsx`) over `GET /api/field/pickers?kind=deal|company|contact&q=&companyId=` (`listPickerOptions` in `pickers.ts`, zod `parsePickerQuery`). Focus or click opens the list with up to 20 records, most recently updated first; typing filters (250 ms debounce, ILIKE with wildcards escaped). `companyId` narrows deals and contacts. Visibility is the CRM's own rule, `ownerOrUnassignedRestriction` in `src/lib/personas/index.ts`, shared with the companies, contacts and deals list pages and `/api/search`: members and viewers see records they own plus unassigned ones; managers, admins and owners see the tenant. Deal rows show amount and stage, company rows the city, contact rows the company. Deal and contact rows carry their company with its site (`PickerCompany`: line, status, located).

Linking (`applyPick` in `picker-link.ts`, pure): picking a deal fills its company (replacing a different one, with a short notice) and its contact; picking a company clears a contact or deal that belongs to another company; picking a contact fills an empty company. A new company fills the address box with its line (only while the place can still change), with a status line under it: "Checked against: company site (pinned / located / not located yet)". An address that no longer equals the company's line shows "This meeting will be checked against this address instead of the company site." and a "Use company site" button that restores the line (`siteCheck`). The server applies the same rule (above). The service's `checkLinks` checks links exist in the tenant; it does not re-apply the owner visibility rule.

## 6. Data minimisation: what location is stored, and where

| Table | What | Notes |
|---|---|---|
| `meeting_checkins` | rep lat/lng, accuracy, distance from site, verified, accepted, reject reason, override reason, `location_source` | Only at check-in and check-out, one row per attempt. PR 1 always writes `'browser'`. Allowed in every provider mode: it is derived check-in data. The walk-in dialog shows "Your location is saved with this check-in" before the browser prompt. |
| `meetings` | site address, lat/lng, `geocode_status`, `site_source`, `site_rep_entered` | The place of the meeting, not a person's position. |
| `companies` | address block, lat/lng, `geocode_status`, optional `checkin_radius_m` | A place. |
| `geocode_cache`, `drive_time_cache` | address to point; point pair to minutes | Per tenant. No user id. |
| `location_pings` | continuous rep trail | Exists, partitioned, and is NOT written in PR 1. Native provider only; forbidden for Ask Mira workspaces (enforced in PR 3). |
| `location_view_audit` | who looked at whose location and why | Exists; written by PR 3 when a trail is viewed. |

Settings page permissions: owners and admins edit every field; managers (`manageFieldCheckinWindow`) see the page and edit only the check-in window, with the rest read-only. `saveFieldSettingsAs` enforces this per field on the server: a patch from a manager that touches any other field is rejected whole (forbidden).

Nothing in PR 1 tracks a rep between check-ins. The settings page shows the location provider disabled ("available later"); tracking hours are stored but have no effect on position capture until PR 3 (they do gate the risk scan).

## 7. Retention (placeholder for PR 3)

PR 1 stores no pings, so there is nothing to purge yet. The contract PR 3 must keep:

- `location_pings` is `PARTITION BY RANGE (captured_at)`, one partition per **UTC day**, named `location_pings_YYYYMMDD`. Primary key `(id, captured_at)`. The migration creates today through +7 days.
- PR 3 adds an Inngest job that creates future partitions ahead of time and drops partitions older than 90 days. Dropping a partition is the retention mechanism; there is no row-level delete.
- Every partition, including ones created by the job, must run `ENABLE` and `FORCE ROW LEVEL SECURITY` and `REVOKE ALL` from `app_user` (and `anon` / `authenticated` where they exist) right after `CREATE`, exactly as migration 0081 does for the first eight. RLS is not inherited by partitions and default privileges grant `app_user` full access to every new table, so a bare partition would let a query that names it directly read every tenant's pings. With RLS on and no policies on the partition, direct access is denied; access through the parent still uses the parent's policies.
- Tenant delete cascades to partitions through the `tenant_id` foreign key.
- Decide in PR 3 whether the 90 days is configurable per tenant. PR 1 assumes a fixed 90.
