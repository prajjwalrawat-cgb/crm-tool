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
- Only the meeting owner can check in, check out, mark en route or log the MOM. Managers act for reps through create/update/cancel/pin only.

## 2. Risk engine

Pure rules in `risk.ts` (`computeRisks`). Reasons per meeting, over one owner's non-cancelled meetings:

| Reason | Rule |
|---|---|
| `no_checkin` | physical, status in planned / en_route / arrived, and `now > start + grace` (default 15 min) |
| `overlap` | two of the owner's meetings intersect in time; both are flagged |
| `travel_gap` | consecutive physical meetings that both have coordinates, and `drive(prev.site, next.site, prev.end) > next.start - prev.end`. Flagged on the later meeting. An overlapping pair gets `overlap` only, no negative gap. |
| `mom_missing` | `checked_out_at + mom_due_hours < now` (default 2 h) and no outcome row |

Drive time comes from `driveMinutesCached`: a 30-minute cache bucket keyed on 4-decimal coordinates, per tenant. Estimates (no `MAPS_API_KEY`, or a Google failure) are never cached, so they cannot mask a later real key, and the UI marks them as estimates.

### The scan (`risk-scan.ts`, `scanTenantRisks`)

Cron `field-risk-scan` (`*/5 * * * *`, `src/lib/inngest/workflows/field.ts`) picks tenants with any non-cancelled meeting starting in `[now - 48 h, now + 24 h]` and scans each under its own system context. A tenant outside its tracking hours (tenant time zone) is skipped, unless the caller passes `ignoreHours` (the seed does).

Window: meetings starting from 48 h ago to the end of today in the tenant's time zone, so a `mom_missing` that falls due after hours is flagged at the next in-hours run.

Three phases, with no row lock held across a network call:

1. One short read transaction: org time zone, field settings, the meetings, outcomes, reporting lines, names. Each meeting's `updated_at` is also read as text, because a JS `Date` cannot hold its microseconds.
2. Compute, with no transaction open. Meetings are grouped by tenant-local day, so pairing (overlap and travel gap) never crosses midnight. Each drive lookup runs in its own short, sequential transaction (cache read, provider call, cache write). Pairs whose later meeting has already started are frozen (`skipDrive`): no re-pricing of past travel, and a stored `travel_gap` on a started meeting is kept.
3. One short write transaction applying each change as a compare-and-swap: the update matches only if status, start, end, `updated_at` (as exact text) and the stored `at_risk_reasons` are all what phase 1 saw. A concurrent edit or scan makes the swap miss and the next run picks it up. Notifications are sent only for rows the swap actually changed. Edits to the other meeting of a pair during a scan are not detected; the next scan corrects them.

Notify-once: for each reason newly added to a meeting, one `field_meeting_at_risk` notification goes to the owner and to the owner's `reports_to_user_id` (nobody else). A reason that clears and later returns is a new appearance. A second run with unchanged inputs writes and notifies nothing.

Check-in clears `no_checkin` and saving the MOM clears `mom_missing` immediately (`array_remove`), without waiting for a scan.

The Field day API (`getDay`) runs the same `computeRisks` live, so the board is current between scans. It does not persist anything and it looks up drive times inside its read transaction (provider calls there are bounded to 4 s).

## 3. Check-in verification

`checkins.ts`. Every attempt is logged in `meeting_checkins`, accepted or not.

1. The caller must own the meeting, and the meeting must be able to move to `checked_in`.
2. Radius = the company's `checkin_radius_m` when the meeting's company has one, else the tenant's `checkin_radius_m` (default 300 m). Both are 50 to 5000 m (DB CHECKs).
3. Distance = haversine between the browser position and the meeting's site (`meetings.lat/lng`, copied from the company or pinned when the meeting was created or last re-sited).
4. Outcomes:
   - Within the radius: accepted, `verified = true`.
   - Outside the radius, no override reason: rejected. The attempt is committed (`accepted = false`, `reject_reason = 'outside_radius'`), then `FieldError('outside_radius')` carries `distanceM` and `radiusM`.
   - Outside the radius with an override reason: accepted, `verified = false`, reason stored.
   - Site has no coordinates: accepted, `verified = false`, `override_reason = 'site_not_geocoded'`, distance null.
5. GPS accuracy is stored with the attempt but does not change the verdict.
6. Check-out records a `kind = 'out'` row with the same distance and verified computation, and is never rejected. On check-out with a linked deal, one `meeting_logged` activity is recorded on the deal, carrying the check-in's verdict.
7. Walk-in: one transaction creates the meeting (`source = 'walk_in'`, start now, 30 minutes, address from reverse geocode, site = the rep's position, `geocode_status = 'manual'`) and a verified check-in. `needs_linking` is set when there is no deal. The reverse geocode happens before any insert, so a provider failure leaves nothing behind.

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

Pins:

- A pin is a Google Maps link (short links resolved server-side) or `lat, lng`. `resolvePin` accepts `@lat,lng`, `?q=lat,lng`, `?query=lat,lng` and a bare pair; (0, 0) and out-of-range values are rejected. Input over 2000 characters is rejected.
- Only owner, admin and manager (`pinFieldSites`) can pin. Reps can never set or move a site.
- Meeting pin (`pinMeetingSite`): sets the point and `geocode_status = 'manual'`. Allowed while the meeting is planned, en_route or arrived. Virtual meetings cannot be pinned.
- Company pin (`pinCompanySite`, used by the company form): sets `lat`, `lng`, `geocode_status = 'manual'` and optionally the per-company `checkin_radius_m` (undefined keeps it, null clears it). It then moves that company's physical meetings that have not started (planned, en_route, arrived) to the new point, except meetings that carry their own manual pin, and fills a blank meeting address from the company's.
- Company address edits (address, city, state, postal code) re-geocode unless the company is `manual`. A company that still has no point is retried on its next save. This does not move existing meetings: only a pin propagates. A company with a manual pin keeps it when its address changes.
- Geocode status in words on the company form: ok "Located", manual "Pinned manually", pending "Not located yet", failed "Couldn't locate".

## 6. Data minimisation: what location is stored, and where

| Table | What | Notes |
|---|---|---|
| `meeting_checkins` | rep lat/lng, accuracy, distance from site, verified, accepted, reject reason, override reason, `location_source` | Only at check-in and check-out, one row per attempt. PR 1 always writes `'browser'`. Allowed in every provider mode: it is derived check-in data. The walk-in dialog shows "Your location is saved with this check-in" before the browser prompt. |
| `meetings` | site address, lat/lng, `geocode_status` | The place of the meeting, not a person's position. |
| `companies` | address block, lat/lng, `geocode_status`, optional `checkin_radius_m` | A place. |
| `geocode_cache`, `drive_time_cache` | address to point; point pair to minutes | Per tenant. No user id. |
| `location_pings` | continuous rep trail | Exists, partitioned, and is NOT written in PR 1. Native provider only; forbidden for Ask Mira workspaces (enforced in PR 3). |
| `location_view_audit` | who looked at whose location and why | Exists; written by PR 3 when a trail is viewed. |

Nothing in PR 1 tracks a rep between check-ins. The settings page shows the location provider disabled ("available later"); tracking hours are stored but have no effect on position capture until PR 3 (they do gate the risk scan).

## 7. Retention (placeholder for PR 3)

PR 1 stores no pings, so there is nothing to purge yet. The contract PR 3 must keep:

- `location_pings` is `PARTITION BY RANGE (captured_at)`, one partition per **UTC day**, named `location_pings_YYYYMMDD`. Primary key `(id, captured_at)`. The migration creates today through +7 days.
- PR 3 adds an Inngest job that creates future partitions ahead of time and drops partitions older than 90 days. Dropping a partition is the retention mechanism; there is no row-level delete.
- Every partition, including ones created by the job, must run `ENABLE` and `FORCE ROW LEVEL SECURITY` and `REVOKE ALL` from `app_user` (and `anon` / `authenticated` where they exist) right after `CREATE`, exactly as migration 0081 does for the first eight. RLS is not inherited by partitions and default privileges grant `app_user` full access to every new table, so a bare partition would let a query that names it directly read every tenant's pings. With RLS on and no policies on the partition, direct access is denied; access through the parent still uses the parent's policies.
- Tenant delete cascades to partitions through the `tenant_id` foreign key.
- Decide in PR 3 whether the 90 days is configurable per tenant. PR 1 assumes a fixed 90.
