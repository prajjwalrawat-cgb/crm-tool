# Saleinx Field Meetings — source build prompt

Transcribed from "Saleinx Field Meetings — Claude Code build prompt" (Nov 24, 2026, @Harry). This is the original
requirement; `docs/superpowers/specs/2026-11-25-field-meetings-design.md` records how it maps to this repo and what each
PR covers.

## Prerequisites outside this prompt
- AskMira exposes a geofence API, an outbound event webhook (geofence.entered/exited, field_day.started/ended) and a
  visit-ingest endpoint. Until it does, M6 builds against the mock.
- Google Cloud and Azure app registrations for calendar OAuth, plus a Maps API key with Distance Matrix and Directions
  enabled.
- DPDP review of the native tracker's consent text and 90-day retention, and of AskMira's consent flow.

## The prompt

Build the "Field Meetings" module in Saleinx end to end.
Stack: Node.js/TypeScript, React, PostgreSQL, Inngest, Anthropic Claude API.

GROUND RULES
- Work in milestones M1→M8 in order. After each one, run migrations, tests, and the seed script, and confirm that
  milestone's acceptance checks pass before starting the next.
- Reuse what already exists in Saleinx: tenant scoping and RLS, auth/SSO, role permissions, the notification service,
  object storage, the call-transcription pipeline, Today's Focus, and the AI suggestions review queue. Do not create
  parallel versions of any of these.
- All timestamps are stored in UTC and shown in the tenant timezone (default Asia/Kolkata).
- Every external provider (Google, Microsoft Graph, Maps, AskMira, Claude) sits behind an interface with a mock, so the
  test suite runs offline.

M1 — DATA MODEL
- meetings: id, tenant_id, deal_id, contact_id, account_id, owner_id, type enum('physical','virtual'), start_at, end_at,
  address, lat, lng, geocode_status, status enum('planned','en_route','arrived','checked_in','checked_out','mom_logged',
  'cancelled'), source enum('manual','gcal','outlook','walk_in'), external_calendar_id, external_event_id,
  external_etag, sync_state, needs_linking bool, at_risk_reasons text[], created_at, updated_at.
  Unique (tenant_id, source, external_event_id).
- meeting_checkins: id, meeting_id, kind enum('in','out'), lat, lng, accuracy_m, distance_from_site_m, verified bool,
  override_reason, location_source enum('askmira','native','browser'), captured_at.
- meeting_outcomes: id, meeting_id, mom_text, audio_url, transcript, summary, next_steps jsonb,
  sentiment enum('positive','neutral','negative'), deal_stage_suggestion, competitor_mentions text[], created_by,
  created_at.
- calendar_connections: id, tenant_id, user_id, provider enum('google','microsoft'), encrypted tokens, scopes,
  sync_token / delta_link, channel_id, channel_expiry, last_synced_at, status, last_error.
- user_identity_links: tenant_id, saleinx_user_id, askmira_employee_id, match_method enum('sso','email','manual').
- location_pings (used ONLY by the native provider): id, tenant_id, user_id, lat, lng, accuracy_m, battery_pct,
  captured_at. Partitioned by day, with a 90-day retention job.
- location_view_audit: id, tenant_id, viewer_id, subject_user_id, viewed_at, context.
- tenant_field_settings: location_provider enum('askmira','native','none'), checkin_radius_m (300),
  no_checkin_grace_min (15), mom_due_hours (2), tracking_hours (09:00–19:00), tracking_interval_sec (120),
  askmira_base_url, askmira_service_token (encrypted), askmira_webhook_secret (encrypted).
- Geocode addresses server-side on create/update, cached by normalized address. Default the meeting address to the
  account address.

M2 — CORE API + RISK ENGINE
- GET /meetings/day?date=&team_id=&at_risk_only=: meetings grouped by owner, joined with deal value/stage and contact,
  plus computed travel_gap_min, est_drive_min (Distance Matrix with departure_time for traffic, cached per
  origin/destination pair for 30 min), and at_risk_reasons[].
- POST /meetings, PATCH /meetings/:id, POST /meetings/:id/cancel.
- POST /meetings/:id/checkin {lat,lng,accuracy}: haversine distance to the site. verified=true if within
  checkin_radius_m. If outside, reject unless override_reason is given, then save with verified=false. Log every attempt.
- POST /meetings/:id/checkout, POST /meetings/:id/outcome.
- POST /meetings/walk-in: create + check in atomically, with the address reverse-geocoded.
- Inngest cron every 5 min during tracking_hours sets these flags: no_checkin (now > start + grace and not checked in),
  travel_gap (est_drive_min > gap), overlap, mom_missing (checked_out more than mom_due_hours ago with no outcome).
  Notify the owner and their manager only when a flag first appears. Clear the flag once resolved.
- Every status change goes through one state-machine function that rejects invalid transitions.

M3 — UI (WEB + MOBILE-RESPONSIVE)
- Manager page /field/today: KPI strip (planned, checked in, at risk, pipeline in play = sum of DISTINCT deals), rep
  swimlanes on a 09:00–19:00 timeline, blocks coloured by status (planned / on site / done with MOM / at risk), dashed
  travel segments, overlap highlighting. Clicking a block opens a side panel with deal, contact, check-in trail, MOM,
  and risk reasons. Filters: date, team, "only at risk". Refresh via the existing realtime channel, or 30s polling as a
  fallback.
- Rep mobile view /field/my-day: meetings in time order with Navigate (Google Maps deep link), Check in, Check out, Log
  MOM, and Log walk-in. Uses high-accuracy browser geolocation, with a warning when accuracy is worse than 100 m. Shows
  the tracking state from the active location provider.
- Permissions: a rep sees their own meetings, a manager sees their team, an admin sees the tenant.

M4 — CALENDAR SYNC (GOOGLE + OUTLOOK)
- OAuth connect per user (Google Calendar API, Microsoft Graph). Tokens encrypted, refresh handled.
- Initial import covers the next 30 days and the past 7. Incremental sync uses Google syncToken with push channels and
  Graph delta queries with subscriptions. Inngest renews channels and subscriptions before expiry.
- Classify an event as physical if it has a non-URL location, or "in-person" / "visit" in the title or description.
  Ignore events that only have a Meet, Teams, or Zoom link.
- Match attendees to contacts by email, then to an account by email domain. Link the deal if exactly one open deal
  exists; otherwise set needs_linking=true.
- Two-way sync: time and location edits made in Saleinx write back to the calendar, guarded by etag. On conflict the
  latest updated_at wins and the conflict is logged. An event deleted at the source soft-cancels the meeting and keeps
  its history.
- Settings page: connect / disconnect, last sync time, errors, and a "needs linking" queue.

M5 — MAP VIEW
- /field/today?view=map: pins for today's meetings coloured by status, numbered in time order per rep, with per-rep
  route polylines (Directions API, cached) and marker clustering. Clicking a pin opens the M3 side panel.
- Live rep position comes from LocationProvider.getLastKnownLocation, fetched only while the map is open (cached 60s)
  and only if isTrackingActive. Every fetch writes a location_view_audit row.
- Toggling between timeline and map keeps the filters.

M6 — LOCATION VIA PROVIDER (ASKMIRA-FIRST, NATIVE FALLBACK)
- interface LocationProvider {
    registerGeofences(userId, [{meeting_id, lat, lng, radius_m, active_from, active_to}]),
    removeGeofences(meetingIds[]),
    getLastKnownLocation(userId) → {lat, lng, accuracy_m, captured_at} | null,
    isTrackingActive(userId) → boolean
  }
  plus one inbound handler for: geofence.entered, geofence.exited, field_day.started, field_day.ended.
- The provider is chosen per tenant from tenant_field_settings.location_provider.
- Geofences are active from start_at - 60m to end_at + 60m. Re-register them whenever a meeting is created,
  rescheduled, or cancelled.
- geofence.entered → status en_route/planned → arrived, and push a check-in suggestion to the rep.
  geofence.exited after check-in → push a check-out suggestion.
- ASKMIRA PROVIDER (default when the tenant has AskMira connected)
  - Identity mapping via user_identity_links (SSO subject first, then work email), with an admin screen for unmatched
    users.
  - Outbound geofence sync uses the AskMira geofence API with a signed service token.
  - Inbound: POST /integrations/askmira/events, HMAC-verified with askmira_webhook_secret, idempotent on event_id.
  - Consent, tracking hours, and the field-day toggle are owned by AskMira. Saleinx shows NO consent screen and writes
    NOTHING to location_pings in this mode. It stores only derived check-in data.
  - Visit feedback: when a meeting reaches checked_out or mom_logged, POST to AskMira {employee_id, meeting_id,
    account_name, address, lat, lng, checkin_at, checkout_at, verified, distance_from_site_m} for field attendance and
    travel allowance. Inngest retries with backoff and dead-letters after 5 failures, with an admin retry screen.
- NATIVE PROVIDER (only when AskMira is not connected)
  - Off by default per tenant. Each user accepts an explicit consent screen and can always see when they are being
    tracked.
  - Tracking runs only inside tracking_hours AND between "Start field day" and "End day". Pings are sent every
    tracking_interval_sec, batched, with an offline queue. Discard any ping with accuracy worse than 200 m.
  - Geofences are evaluated server-side on incoming pings and emit the same internal events as the AskMira path.
- NONE
  - Manual check-in with browser geolocation only. No live dot and no geofence suggestions.
- Switching a tenant's provider re-registers all of today's remaining geofences with the new provider.

M7 — VOICE MOM + AI EXTRACTION
- Log MOM accepts text or a voice note (recorded in the browser, uploaded to object storage).
- An Inngest job sends the audio through the existing Saleinx transcription pipeline. It must handle Hindi-English
  code-mixed speech.
- Call the Claude API with the transcript plus deal context and require JSON: {summary, next_steps[{action, owner,
  due_date}], sentiment, deal_stage_suggestion, competitor_mentions[]}. Validate with zod and retry once on invalid
  output. If it is still invalid, save the transcript and flag the outcome for manual review.
- Push next_steps into Today's Focus as follow-ups for the owner. Send deal_stage_suggestion to the AI suggestions review
  queue as a one-click accept. Never change the deal stage automatically.
- Saving an outcome sets status mom_logged and clears the mom_missing flag.

M8 — TESTS, SEED, DOCS
- Unit tests: haversine and radius check, each risk rule, the state machine, attendee→contact matching, the
  physical-vs-virtual classifier, provider selection, and AI output schema validation.
- API tests: check-in reject / override, walk-in atomicity, permission scoping, calendar webhook idempotency,
  cancellation of a deleted event, AskMira webhook (valid, duplicate event_id, bad HMAC, unmapped employee), and
  visit-feedback retry.
- Mode assertions: with provider=askmira, location_pings stays empty and no Saleinx consent screen renders. With
  provider=native, no pings are stored outside tracking hours or after End day.
- Seed: 2 tenants (one AskMira-connected, one Saleinx-only), 1 manager plus 3 reps each, 3 meetings per rep in Noida,
  Gurugram, and Okhla, including one overlap, one tight travel gap, and one past-due no-check-in.
- README: every env var (GOOGLE_*, MS_GRAPH_*, MAPS_API_KEY, ANTHROPIC_API_KEY, ASKMIRA_*).
- ARCHITECTURE.md: meeting state machine, risk engine, calendar sync flow, LocationProvider contract and data flows with
  AskMira, consent and data-minimisation model, and retention.

ACCEPTANCE (all must pass before you declare done)
- A check-in 500 m from the site is rejected, then accepted with an override reason as verified=false, and both
  attempts are logged.
- No check-in by start + 16 min turns the block amber, and the manager gets exactly one notification.
- Meetings 12 km apart with a 20-minute gap get the travel_gap flag.
- KPI pipeline counts each deal once, even when it has several meetings.
- A Google event with an office address imports as a physical meeting. A Teams-only event is ignored.
- Rescheduling in Saleinx updates Google or Outlook within one sync cycle. Deleting in Outlook cancels the meeting in
  Saleinx.
- An AskMira geofence entry produces a check-in suggestion within 30s. A verified visit appears in AskMira field
  attendance, and an override arrives with verified=false.
- Turning tracking off in AskMira removes the live dot on the next map refresh.
- A 2-minute Hindi-English voice note produces a valid summary and next steps. The next steps appear in Today's Focus,
  and the stage suggestion waits in the review queue.
- The Saleinx-only tenant works end to end on the native provider.
