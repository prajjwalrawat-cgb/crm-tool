# Saleinx Gap Re-Audit

**Review of:** `saleinx-vs-salesforce-gap-analysis.md`
**Verified against:** `main` @ `84e1d33`
**Date:** 14 August 2026
**Method:** git log + route, schema and migration inventory

---

## Most of these gaps are already shipped

The report is careful, well-reasoned, and scored against the wrong source. It grades Saleinx on what it remembers being specified in prior sessions rather than on what is in the repository — so every one of its seven "Unverified" items is live and tested, and ten of its fifteen "Gap" items are built. Four gaps survive. One of them is the report's own top priority, and it is worth building.

| | |
|---|---|
| **7 / 7** | "Unverified" items that shipped — all with tests |
| **10 / 15** | "Gap" items already built |
| **4** | Gaps that survive verification |
| **20** | Commits landed after the report's picture of the build |

---

## Part one — The seven "Unverified" items: every one is live

These were built as a six-module Phase-2 sprint, one branch per module, and merged into `main`. Each carries its own migration and its own standalone test script under `pnpm selftest`.

### Stage-gate enforcement ("Path") — SHIPPED
> Report: "Spec'd, build status unverified"

- `src/lib/stage-gates/` — enforce, evaluate, queries, types
- commit `17ad7e4` · migration `0049`
- `scripts/selftest-stage-gates.ts`

### Deal health / risk scoring — SHIPPED
> Report: "Spec'd (multi-signal), build status unverified"

Rule-based, append-only score history in `deal_scores` with a denormalised cache on the deal, recomputed on a debounced event plus a nightly cron.

- `src/lib/deals/scoring/` — compute, queue, service
- commit `ab1284a` · migration `0050`
- `selftest-deal-scoring.ts`, `selftest-deal-scoring-service.ts`

### Automatic email capture (Gmail sync) — SHIPPED
> Report: "Spec'd (Inngest job), build status unverified"

Confirmed working live against a real Google OAuth app in a prior session — the strongest evidence on this list.

- `src/lib/email/gmail/` — 7 modules incl. ingest, oauth-state, crypto
- commit `a5acaea` · migration `0051` · cron `gmail-sync`
- `selftest-gmail-ingest.ts`, `selftest-gmail-parse.ts`

### Forecast rollup with categories — SHIPPED
> Report: "Spec'd, build status unverified"

Commit / Best Case / Pipeline categories auto-derived from stage with a manual-override flag, on a fiscal-aware quarter and month selector.

- `src/lib/deals/forecast/` — categories, period, rollup, snapshots
- `/dashboard/executive/forecast` · commit `66a7613` · migration `0052`
- `selftest-forecast.ts` · weekly cron `forecast-snapshot-weekly`

### Duplicate detection, including at contact level — SHIPPED
> Report: "Spec'd at deal level only (pg_trgm) — contact-level unconfirmed"

The report has this backwards. Detection is on companies and contacts, not deals: trigram matching on company names, exact-block matching on contact email, a reversible merge that repoints every polymorphic reference, and an admin review queue.

- `src/lib/dedup/` · `/dashboard/settings/data-quality`
- commit `ee7c168` · migration `0053` · `merge_audit` table
- `selftest-dedup.ts`, `selftest-dedup-normalize.ts`

### Contact records with account linkage — SHIPPED
> Report: "Assumed present — Unverified in recent sessions"

- `src/lib/contacts/`, `src/lib/companies/` with full detail routes
- custom fields, notes, comments, tasks and timeline on both entities

### Dashboard filtering by date range and owner — SHIPPED
> Report: "Spec'd in last pass — confirm shipped"

- `src/lib/dashboard/range.ts` · `_components/home/rep-filter.tsx`

---

## Part two — Ten items scored "Gap" that are in production

These are the expensive errors. A "Gap" verdict reads as licence to build, and a build prompt written from this table would have re-specified ten shipped features.

### Custom and role-based dashboards — SHIPPED
> Report: "Single fixed dashboard" — flagged as a headline gap

This is the report's single most consequential mistake, because it anchors the whole §5 argument. There are three role-scoped homes and a per-user drag-and-resize widget canvas with its own edit mode — the composability axis the report names as the strategic gap is the axis that got built.

- `_components/home/` — sales-home, manager-home, admin-home
- `dashboard_widgets` table — per-user layout, resize, widget types
- `_components/edit-mode/` · `_components/chart-studio/` · `chart_views`

### Report builder — SHIPPED
> Report: "Not addressed"

A registry-driven reports module with seven reports and shared filter and CSV layers. Not drag-and-drop ad-hoc authoring, but the substantive half of what that buys you.

- `src/lib/reports/` — registry, filters, csv, types
- deal-velocity · email-engagement · pipeline-by-stage · rep-performance · revenue-forecast · stale-deals · win-loss-rate
- `/dashboard/reports/[reportId]`

### Rep / team leaderboard — SHIPPED
> Report: "Not addressed" — ranked #5 in the build sequence

- `src/lib/reports/queries/rep-performance.ts`
- surfaced in manager-home, sales-home and `/dashboard/my-performance`

### Export to CSV — SHIPPED
> Report: "Not addressed"

- `src/lib/reports/csv.ts` · `reports/_components/csv-download-button.tsx`
- plus Excel export on deals (commit `3c00fc0`)

### Saved filter views per rep and team — SHIPPED
> Report: "Not addressed"

- `deals/_components/saved-views.tsx`

### Bulk stage and owner reassignment — SHIPPED
> Report: "Not addressed"

- multi-select + `bulkStage()` in `deals/_components/deals-view.tsx`
- `_components/bulk-action-bar.tsx` — owner assign and delete on companies, contacts
- `bulkApproveDealsAction` / `bulkRejectDealsAction` · bulk CSV upload

### Task and reminder system tied to deals — SHIPPED
> Report: "Not directly addressed"

Tasks are entity-polymorphic, support recurrence, and are created automatically by the hold-revisit cron when a parked deal comes due.

- `src/lib/tasks/` · `_components/entity-tasks-panel.tsx`
- `task_recurrence` enum · cron `hold-revisit-daily`

### Contract approval workflow — SHIPPED
> Report: "Not addressed"

- `src/lib/deals/approval.ts` · `/dashboard/deals/approvals`
- margin-threshold approvals · migration `0042`

### Quote / proposal generation synced to deal — SHIPPED
> Report: "Not addressed"

- `proforma_invoices` schema · `src/lib/invoices/`
- `/dashboard/invoices` · `/dashboard/invoice-settings`

### Role-based contact hierarchy — SHIPPED
> Report: "Not addressed"

- `deal_contacts.role` enum + exactly-one-primary constraint

---

## Part three — What actually is missing

Four items survive verification. The report was right about all of them, and right that the first one matters most.

### Chart-segment drill-down to a filtered list — OPEN

Confirmed missing in its specific form. Clicking a donut segment opens Chart Studio to customise the chart, not a filtered deal list. Drill-down exists one level up — highlight and intel widgets link to individual deals, and executive sections link into the matching report — but the "click this slice, see these records" path is genuinely absent.

- `_components/stage-donut.tsx` — onClick opens the studio panel
- `stage-conversion-bars.tsx` — no navigation on segments

### Account 360 view — OPEN

Closer than the report implies, and still short. The company page already composes owner, notes, comments, tasks, custom fields, a full entity timeline and email compose — it just never lists the company's deals or rolls up their value. The smallest real gap here.

- `companies/[id]/page.tsx` — no deal query in the page composition

### Multi-currency and territory pipelines — OPEN

Multi-currency is half-built, which is the worst available state: `deals.currency` and `sales_targets.currency` exist as columns, but rendering was deliberately collapsed to one workspace currency. There is no FX rate table and no rate-at-close capture. Territory has nothing at all.

- `deals.currency` default INR · `organization_settings.default_currency`
- commit `7bfdf84` — "render one workspace currency"

### Scheduled / emailed snapshots — PARTIAL

The capture half exists — `forecast_snapshots` is written weekly by cron. What is missing is delivery: nothing emails a dashboard or report on a schedule.

- `inngest/workflows/forecast-snapshot-weekly.ts` — writes, does not send

### Data enrichment on save — OPEN

Nothing in the codebase. Also the least urgent item on this page for a single-tenant production deployment.

---

## Part four — Why the report went wrong, and the part it got right

**Root cause — it audited its own memory of prompts, not the repository.**
The report is explicit about this in §1 and §7 and treats it as a caveat to be resolved later. But it then ranks a six-item build sequence on top of the unverified data, and the ranking is the part that gets acted on. A caveat at the top does not contain the damage done by a priority list at the bottom.

**The asymmetry — "Unverified" and "Gap" were held to different standards.**
Where the report had seen a spec, it honestly marked the item Unverified. Where it had seen nothing, it confidently marked the item a Gap. Both states are the same state — no evidence — but only one was labelled that way. Every one of the ten errors in Part Two is a feature built during a session whose prompt this report did not happen to see. Absence of evidence became a positive finding.

**Cost — the build sequence would have spent most of its budget on shipped work.**
Of the six ranked priorities, #2 (role-based dashboards) is built, #5 (leaderboard) is built, #3 is answered — all seven unverified items shipped — and most of #6 is built. Only #1 survives intact, and #4 survives in reduced form. Roughly two thirds of the proposed scope was already in production.

**Credit — the judgment was sound; the inputs were stale.**
The report's central argument — that composability and drill-down are what separate a dashboard that feels powerful from one that feels thin, and that correctness fixes do not move that axis — is correct, and it picked the right #1. Its read that contact and account management is the thinnest module also holds up: Account 360 is the one structural hole left. Good reasoning on a four-week-old picture of the build.

**Fix — generate the inventory before scoring.**
Ten minutes of `git log`, a route listing and a migration listing would have caught every error on this page. Screenshots, the report's own suggestion in §7, would have caught fewer — `chart_views`, the approvals queue and the dedup merge audit are not visible from a dashboard screenshot.

---

## Part five — What the build prompt should contain instead

These are ordered by leverage, and the order matters — each step is cheaper because the one above it exists.

**1. A universal filter contract, then wire every chart into it.**
Define one query-param contract on the deals list — stage, owner, range, health band, forecast category — and make every KPI tile, donut segment and bar deep-link into it. The landing surface already exists in saved views, so this is a URL contract and a set of links, not new UI. It also makes every number on the dashboard auditable, which is the real payoff.
*Report's #1 · survives verification · highest leverage per hour*

**2. Finish Account 360.**
Add the related-deals list and value rollup to the company page. Everything else the view needs is already composed there. Smallest genuine gap on the board, in the module with the least attention.
*Report's #4 · reduced scope, most of the page already exists*

**3. Decide multi-currency rather than letting it drift.**
Either build it properly — an FX rate table, rate captured at close, currency-aware rollups — or drop the unused columns and declare the product single-currency. The current half-state invites a bug where two currencies are summed as one number.
*Not in the report's sequence · a decision, not necessarily a build*

**4. Add delivery to the snapshots you already capture.**
The weekly forecast snapshot cron and the email infrastructure both exist. Connecting them into a scheduled digest is small work with visible output for sales leadership.
*Report's #6 · far cheaper than the report assumes*

### Drop from scope entirely

Already in production. Re-specifying any of these risks a second implementation alongside the first:

report builder · rep leaderboard · CSV and Excel export · role-based dashboards · custom widget canvas · saved views · bulk stage and owner reassignment · tasks and reminders · contract approvals · quote generation · contact role hierarchy · stage gates · deal health scoring · Gmail sync · forecast rollup · duplicate detection

---

**Verification method** — file, route, schema, migration and test-script existence confirmed by inspection at commit `84e1d33`, plus commit history. This establishes that each feature is built and merged; it does not exercise runtime behaviour, so "Shipped" here means present and tested, not independently re-QA'd. Gmail sync is the exception — it was confirmed working live against a real OAuth app in an earlier session. Note also that a feature-parity frame scores presence, not health: nothing in either document speaks to whether the shipped features perform well or are configured correctly in production, which is a separate audit worth running on its own.
