# Saleinx Field Meetings — Developer brief

Transcribed from "Saleinx Field Meetings — Developer brief" (Nov 24, 2026, @Harry). Companion to
[source-spec.md](source-spec.md) (the build prompt). How it maps onto this repo and the three-PR split:
`docs/superpowers/specs/2026-11-25-field-meetings-design.md`.

## What we're building

A Field Meetings module in Saleinx. It gives sales managers one board each morning showing every physical customer
meeting their team has planned, whether each one is on track, and what came out of it.

Today, physical meetings live in personal calendars and WhatsApp. Managers can't see who is where, visits can't be
verified, and minutes of meetings (MOMs) rarely reach the CRM. The module fixes that with geo-verified check-ins,
automatic risk flags, calendar sync and voice MOMs.

| User | Main screen | What they do |
|---|---|---|
| Sales manager | `/field/today` (timeline + map) | Sees the team's day, acts on at-risk meetings, reviews outcomes |
| Field rep | `/field/my-day` (mobile web) | Navigates, checks in and out, logs a MOM by voice, logs walk-ins |
| Tenant admin | Settings | Connects AskMira, picks the location provider, sets radius and tracking hours |

### What success looks like
- A manager can tell at 10 am which meetings are at risk, without calling anyone.
- Every completed visit carries a verified check-in and a MOM, and its next steps appear in Today's Focus.
- On AskMira tenants, the rep's phone runs one tracker and shows one consent screen, not two.
- The module works for Saleinx-only customers too (competitive with LeadSquared's GPS check-in).

## How it fits together

Internal parts: Meetings API (state machine, check-in, walk-in), Risk engine (Inngest cron, four flags),
LocationProvider (AskMira / native / none), MOM pipeline (voice, transcript, Today's Focus).
External services: Google / Outlook (two-way event sync), Maps APIs (geocoding, drive times), AskMira HRMS (GPS,
consent, geofences), Claude API (MOM summary, next steps). Both front ends call the Meetings API. The LocationProvider is
the only part that talks to AskMira.

## Meeting lifecycle and risk rules

1. Planned — created manually, from calendar sync, or as a walk-in.
2. En route — the rep has started moving toward the site.
3. Arrived — entered the site geofence; the app suggests a check-in.
4. Checked in — verified if within 300 m of the site; outside that, an override reason is required and the check-in is
   stored as unverified.
5. Checked out — the app suggests a check-out on geofence exit.
6. MOM logged — outcome saved by text or voice; next steps go to Today's Focus.

A meeting can be cancelled from any state before check-in, in Saleinx or by deleting the calendar event.

| Flag | Fires when | Default threshold |
|---|---|---|
| no_checkin | Start time passed and no check-in | 15 min grace |
| travel_gap | Estimated drive time longer than the gap since the previous meeting | Distance Matrix with live traffic |
| overlap | Two meetings for the same rep overlap | — |
| mom_missing | Checked out with no outcome saved | 2 hours |

The owner and their manager get one notification when a flag first appears. A flag clears itself once resolved.

## Saleinx vs AskMira

AskMira owns where the employee is; Saleinx owns which customer they met. Saleinx never runs a second tracker on AskMira
tenants and never stores AskMira's raw GPS pings.

| Area | AskMira (HRMS) | Saleinx (CRM) |
|---|---|---|
| GPS pings | Owns and stores them | Never stores them in AskMira mode; fetches last-known location on demand for the map |
| Consent, tracking hours, field-day toggle | Owns them, one consent screen | Reads tracking state, shows no consent screen |
| Geofences | Evaluates, emits enter/exit | Defines per meeting (site ±60 min), syncs to AskMira |
| Check-ins, MOMs, risk flags | Not involved | Owns them |
| Field attendance, travel allowance | Owns them, fed by Saleinx visit records | Sends a verified visit record after each meeting |

LocationProvider modes: `askmira` (default when connected), `native` (Saleinx tracker, own consent, tracking-hours
limits, 90-day retention), `none` (manual browser check-in).

## Build sequence (done-when per milestone)

| # | Milestone | Done when |
|---|---|---|
| M1 | Data model | Migration reviewed and RLS tested |
| M2 | Core API + risk engine | A 500 m check-in is rejected, and a late meeting raises exactly one alert |
| M3 | UI | Reps see only their own lane, and the KPI counts each deal once |
| M4 | Calendar sync | A Teams-only event is ignored, and an event deleted in Outlook cancels the meeting |
| M5 | Map view | Every location view is audited |
| M6 | Location provider | AskMira mode writes zero pings, and a geofence entry suggests check-in within 30 s |
| M7 | Voice MOM + AI | A Hindi-English note yields valid next steps, and the stage never changes by itself |
| M8 | Tests, seed, docs | All acceptance checks in the prompt doc pass |

## Non-negotiables
- Reuse existing tenant scoping, RLS, auth, notifications, object storage, transcription pipeline, Today's Focus and the
  AI suggestions queue. No parallel versions.
- Timestamps in UTC, shown in IST (tenant timezone).
- Every external provider behind an interface with a mock; tests run offline.
- AI never changes a deal stage by itself.
- Don't track a rep outside tracking hours or after End day. Log every view of someone's location.
- Webhooks idempotent and HMAC-verified. Outbound calls retried through Inngest with a dead-letter queue.

## Open questions (as of Nov 24)
- AskMira team: when will the geofence API, event webhook and visit-ingest endpoint be ready? (M6 builds against a mock until then.)
- Compliance: DPDP sign-off on consent text and 90-day ping retention.
- Ops: Google Cloud and Azure app registrations; Maps key with Distance Matrix and Directions.
- Product: is 300 m right for large industrial sites, or per-account radius? — **Decided 2026-11-25: optional
  per-company radius (`companies.checkin_radius_m`), set by managers next to the site pin; tenant default applies
  when empty.**
