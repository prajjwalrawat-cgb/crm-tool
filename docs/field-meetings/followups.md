# Field Meetings PR 1 — follow-ups

Deferred findings from the PR 1 task and branch reviews (2026-11-25). None block merge; triage before PR 2/3 or when the Maps key goes live.

## Open product decisions
- Check-in time window: today a rep can check in to any of their meetings at any time (e.g. next week's while at the site). Option: reject or mark unverified outside ~[start−2h, end+4h].
- Reps setting a site by typing an address on their own meeting: once MAPS_API_KEY is set, Google geocodes it and check-ins verify against it. Options: require manager confirmation for address-sourced sites on rep-created meetings, or reject coordinate-shaped addresses without pinFieldSites.
- Company re-geocode does not move not-started meetings that already hold the old company point.
- pinCompanySite moves meetings of reps outside the pinner's scope, and meetings with their own different address (label/point disagree).

## Deferred minors
- Task 1: minor (deferred, raise at user migration review): meetings.owner_id FK no ON DELETE action
- Task 1: minor (deferred, raise at user migration review): tenant_field_settings numeric settings have no CHECKs (radius can be 0/neg)
- Task 1: minor (deferred, raise at user migration review): child FKs meeting_id don't enforce same tenant; composite (tenant_id, meeting_id) FK possible
- Task 1: minor (deferred): Drizzle constraint names differ from SQL (meeting_outcomes unique, no check() in Drizzle)
- Task 1: minor (deferred): pings partition naming/bounds contract for PR 3 (being documented in fix round 1)
- Task 1: minor (deferred): PR 3 retention must drop partitions / delete via parent (FORCE RLS on partitions)
- Task 1: minor (deferred): field.ts indentation in meetingOutcomes/tenantFieldSettings bodies; long check() lines (lint)
- Task 2: minor (deferred): no exact-boundary tests (no_checkin at start+15, mom_missing at 120 min)
- Task 2: minor (deferred): parseSiteInput NUM lacks trailing boundary (geo.ts:279) — add (?![\d.])
- Task 2: minor (deferred): estimateDriveMinutes same point returns -0 (epsilon)
- Task 2: minor (deferred): diffReasons test weak (no removed/order case)
- Task 2: minor (deferred): zero-length meeting at same start not counted as overlap
- Task 3: minor (deferred): Distance Matrix quota failure silently becomes estimate (no warn log)
- Task 3: minor (deferred): isWithinTrackingHours throws RangeError on invalid tz — callers must validate/fallback (T5 note)
- Task 3: minor (deferred): isWithinTrackingHours tests only in DB selftest (settings.ts server-only)
- Task 3: minor (deferred): cache fetchedAt in future treated fresh forever
- Task 3: minor (deferred): past departAt clamped to now but bucket from original departAt
- Task 3: minor (deferred): wire selftest:field-db into a chain before PR (final review)
- Task 3: minor (deferred): pathname.startsWith('/maps') also matches /mapsfoo (harmless w/ host allowlist)
- Task 4: minor (deferred): getDay joins lack explicit tenant_id on deals/contacts/companies (RLS covers)
- Task 4: minor (deferred): localMidnight in zones without local midnight (DST) one hour early
- Task 4: minor (deferred): rep address edit re-geocodes own meeting site (Google-based, not GPS) — raise in final review
- Task 4: minor (deferred): clearing companyId keeps old coords; virtual→physical leaves no site
- Task 4: minor (deferred): manager-without-reports fallback lets them manage owner/admin meetings (existing scopeUsers semantics)
- Task 4: minor (deferred): selftest race timers not cleared (~20s idle exit)
- Task 4: minor (deferred): pinCompanySite moves non-manual meetings with own different address (label/point disagree) and meetings of reps outside pinner's scope — product confirm in final summary
- Task 4: minor (deferred): ownerId not validated before assertActiveMember (T6 zod should validate)
- Task 4: minor (deferred): getDay cold-cache drive calls sequential inside read tx (with real key: N pairs × up to 4s) — consider parallel/prefetch
- Task 4: minor (deferred): meetings.ts 452 lines (pin fns could move to site.ts)
- Task 5: minor (deferred → T7/T8): notification href /dashboard/field/today is manager-only; reps should land on my-day (handle in UI tasks)
- Task 5: minor (deferred): reasons on meetings outside window stay as history (comment)
- Task 5: minor (deferred): stored travel_gap kept on started meeting even if now virtual/site-less — keep only when physical && lat != null
- Task 5: minor (deferred): per-day grouping drops overlap for meetings crossing midnight
- Task 5: minor (deferred): docblock line too long
- Task 6: minor (deferred): actor.ts auth()/getCurrentTenant outside try — unreported bare 500 on failure
- Task 6: minor (deferred): atRiskOnly unrecognised values silently false
- Task 7: minor (deferred): check-in button re-enabled between success and refresh → 409 on quick 2nd tap; add done stage
- Task 7: minor (deferred): FieldSheet no focus trap/restore (house pattern); New meeting/Walk-in no autofocus
- Task 7: minor (deferred): New meeting sheet closable mid-save (no busy)
- Task 7: minor (deferred): meeting-form default after 22:00 wraps end to 00:00 same date → fails validation; default date ignores viewed day
- Task 7: minor (deferred): tz-context silent Asia/Kolkata fallback if provider missing
- Task 7: minor (deferred): notes textarea no maxLength
- Task 7: minor (deferred): MOM draft persisted on open (stale draft precedence)
- Task 7: minor (deferred): ?m highlight visual only (aria-current)
- Task 7: minor (deferred): getOrgSettings read twice
- Task 7: minor (deferred): picker Escape swallowed on whitespace-only term; Enter not guarded for IME isComposing
- Task 8: minor (deferred): datetime partsIn builds Intl.DateTimeFormat per call (~900/render) — cache per tz
- Task 8: minor (deferred): ?m= to cancelled meeting opens panel though notice says cancelled not on board
- Task 8: minor (deferred): open panel silently unmounts if refresh drops meeting (only-at-risk cleared)
- Task 8: minor (deferred): realtime refresh fires while tab hidden
- Task 8: minor (deferred): connector label overflow on very short gaps (browser check)
- Task 8: minor (deferred): connector with estDriveMin null unlabeled
- Task 8: minor (deferred): 4% min block on narrow lanes truncates title (aria/title carry full text)
- Task 9: minor (deferred): seed --reset deletes users by usr_field_ prefix DB-wide
- Task 9: minor (deferred): company pin committed in own tx before main update (non-atomic)
- Task 9: minor (deferred): failed-geocode company retries geocode on every save (cache read)
- Task 9: minor (deferred): raw zod issue text in settings errors
- Task 9: minor (deferred): seed assumes Asia/Kolkata; needs >5.5h left in day
- Final wave: started meeting's travel_gap chip shows no figures; Edit on midnight-spanning meetings rebuilds end on start date; Edit sheet closable by Escape mid-save; edit form shows old company's address until saved.
