# Multi-Tenant CRM — Test Flows & QA Plan

**Document type:** Test plan / QA flows
**Audience:** QA engineers, developers writing tests, release managers
**Companion doc:** `CRM-Process-and-Business-Flows.md`
**Scope:** Functional, RBAC, multi-tenancy isolation, AI, real-time, regression

> **How to read this document.** Each test flow is written as: **Objective → Preconditions → Steps → Expected results → Edge cases**. IDs (e.g., `TF-DEAL-03`) are stable references for traceability. "member+" means "member role or higher."

---

## Table of contents

1. [Test strategy & principles](#1-test-strategy--principles)
2. [Test environment & setup](#2-test-environment--setup)
3. [Test data](#3-test-data)
4. [Automated self-tests (existing)](#4-automated-self-tests-existing)
5. [Functional test flows](#5-functional-test-flows)
   - 5.1 Authentication & onboarding
   - 5.2 Team & RBAC
   - 5.3 Companies & contacts
   - 5.4 Deal lifecycle
   - 5.5 CSV bulk upload
   - 5.6 Tasks, notes & comments
   - 5.7 Communications & email
   - 5.8 Reports & dashboards
   - 5.9 AI / intelligence
   - 5.10 Real-time collaboration
   - 5.11 Soft delete & restore
   - 5.12 Background jobs & workflows
   - 5.13 Global search
6. [Multi-tenancy isolation tests (critical)](#6-multi-tenancy-isolation-tests-critical)
7. [RBAC permission matrix tests](#7-rbac-permission-matrix-tests)
8. [Non-functional checks](#8-non-functional-checks)
9. [Regression checklist before release](#9-regression-checklist-before-release)
10. [Defect reporting template](#10-defect-reporting-template)

---

## 1. Test strategy & principles

| Principle | Why it matters here |
|---|---|
| **Tenant isolation is priority #1** | A cross-tenant leak is a critical security defect. Every data feature must be tested with at least two tenants. |
| **Test the "empty result" trap** | RLS fails closed — missing tenant context returns zero rows silently. Verify data *appears* when it should, not just that no error is thrown. |
| **RBAC is server-enforced** | Don't test only the UI (hidden buttons). Attempt the action directly to confirm the server rejects it. |
| **AI runs in mock mode for deterministic tests** | Set `AI_ENABLED=false` so AI flows produce stable, repeatable output without external calls. |
| **Real-time needs two sessions** | Presence/typing/live-update flows require two concurrent browser sessions. |
| **Money is in minor units** | Always verify amount conversions (cents ↔ display). |

---

## 2. Test environment & setup

| Item | Command / value |
|---|---|
| Install deps | `npm install` |
| Validate env vars | `npm run env:check` |
| Run app | `npm run dev` (port 3000) |
| Run background jobs | `npm run inngest:dev` (expects app on 3001) |
| Seed demo data | `npm run seed:demo` |
| Seed load/stress data | `npm run seed:stress` |
| Reset demo data | `npm run seed:reset` |
| Inspect demo state | `npm run demo:inspect` |
| AI mode for tests | set `AI_ENABLED=false` (mock) for deterministic runs |
| Email test | `npm run email:test` / `npm run email:send-test` |
| Lint / build | `npm run lint` / `npm run build` |

**Required accounts/keys for full coverage:** Clerk test org + at least 4 users (one per role), `DATABASE_URL`, optionally `OPENAI_API_KEY` (omit/disable for mock-mode tests).

---

## 3. Test data

Create at minimum:

- **Two tenants** (Tenant A "Acme", Tenant B "Globex") — for isolation tests.
- **Four users in Tenant A:** owner, admin, manager, member (+ optionally viewer).
- **Companies/contacts/deals** across all stages (`lead`…`won`/`lost`), with varied owners (so sales-scoping is testable).
- **At least one soft-deleted record** of each type.
- **At least one deal owned by another sales rep** (to verify a salesperson cannot see it).

Use `seed:demo` for a realistic baseline; `seed:stress` for pagination/performance.

---

## 4. Automated self-tests (existing)

The repo ships self-tests — run these first as a smoke gate:

```bash
npm run selftest      # lifecycle + AI/observability + workflows + pagination
npm run bench         # query benchmarks
```

| Self-test | Covers |
|---|---|
| `selftest-lifecycle` | Core entity create/update/delete lifecycle |
| `selftest-ai-and-observability` | AI invocation + tracing/metrics |
| `selftest-workflows` | Inngest workflow execution |
| `selftest-pagination` | Cursor pagination correctness |

**Expected:** all self-tests pass before manual testing or release.

---

## 5. Functional test flows

### 5.1 Authentication & onboarding

**TF-AUTH-01 — Unauthenticated redirect**
- **Objective:** Unauthenticated user cannot reach the app.
- **Steps:** Visit `/dashboard` while signed out.
- **Expected:** Redirected to `/sign-in`.

**TF-AUTH-02 — Org selection gate**
- **Objective:** Signed-in user without an active org is gated.
- **Steps:** Sign in; do not select an org; visit `/dashboard`.
- **Expected:** Redirected to `/select-org`.

**TF-AUTH-03 — New tenant provisioning**
- **Objective:** Creating an org provisions a tenant and owner.
- **Steps:** Create a new Clerk organization.
- **Expected:** A `tenants` row is created (linked to the Clerk org); the creator has an **owner** membership; lands on `/dashboard` with admin persona.
- **Edge:** Verify the webhook ran (check tenant/membership rows exist even before any manual action).

**TF-AUTH-04 — Public routes**
- **Expected:** `/sign-in`, `/sign-up`, `/api/webhooks/*`, `/api/inngest/*` are reachable without auth.

---

### 5.2 Team & RBAC

**TF-TEAM-01 — Invite a member**
- **Preconditions:** Logged in as owner/admin/manager.
- **Steps:** Invite an email with role = `manager`.
- **Expected:** A `pending_role_intents` row is written; a Clerk invitation is created; invitee gets an email.

**TF-TEAM-02 — Accept invite resolves correct role**
- **Steps:** Invitee accepts the invitation from TF-TEAM-01.
- **Expected:** Membership created with role = **manager** (intent consumed), even though Clerk's native role is `member`. The pending intent row is removed.

**TF-TEAM-03 — Change role (owner only)**
- **Steps:** As owner, change a member to admin. Repeat as admin.
- **Expected:** Owner succeeds; **admin is denied** (only owner can change roles). Activity log + realtime event emitted on success.

**TF-TEAM-04 — Remove member protections**
- **Steps:** Attempt to remove the last owner.
- **Expected:** Blocked. Removing a normal member succeeds, deletes from Clerk + locally, and clears any stale pending intent.

---

### 5.3 Companies & contacts

**TF-CO-01 — Create company**
- **Steps:** As member+, create a company with name/domain/industry.
- **Expected:** Appears in list; activity log "created"; realtime "company.created" received by other open tabs.

**TF-CO-02 — Create contact linked to company**
- **Expected:** Contact saved with `company_id`; visible on company detail page; AI embedding refresh queued.

**TF-CO-03 — Validation**
- **Steps:** Submit a company with missing required fields / invalid email on a contact.
- **Expected:** Zod validation errors shown inline; no row created.

**TF-CO-04 — Pagination & search**
- **Preconditions:** Seed many companies (`seed:stress`).
- **Expected:** Cursor pagination works (next/prev), search filters results, page size respected.

---

### 5.4 Deal lifecycle

**TF-DEAL-01 — Create deal**
- **Steps:** Create a deal with name, amount, currency, expected close date, owner, optional company/contact.
- **Expected:** Deal saved; **amount persisted in minor units (cents)** and displayed correctly; activity log "created"; realtime "deal.created"; `crm/deal.created` event fired.

**TF-DEAL-02 — Stage progression (list view, inline edit)**
- **Steps:** Move a deal `lead → qualified`.
- **Expected:** Stage updated; activity log "stage_changed" with `from`/`to` in metadata; realtime "deal.stage_changed".

**TF-DEAL-03 — Stage change via Kanban drag**
- **Steps:** On `/dashboard/deals/board`, drag a card to a new column.
- **Expected:** Same outcomes as TF-DEAL-02; the card moves; per-stage counts update; **a second open session updates live**.

**TF-DEAL-04 — Mark won**
- **Steps:** Move a deal to `won`.
- **Expected:** `closed_at` set; deal-won workflow triggered (visible in `/dashboard/workflows`); outcome recorded (+1); AI summary marked stale and regenerates.

**TF-DEAL-05 — Mark lost from any stage**
- **Steps:** Move a `lead` directly to `lost`.
- **Expected:** Allowed; `closed_at` set; deal-lost workflow triggered; outcome recorded (-1).

**TF-DEAL-06 — Filters**
- **Steps:** Filter by stage, owner, company, amount range; combine filters; toggle list/board.
- **Expected:** Results match filters; filters persist across list/board switch.

**TF-DEAL-07 — Sales scoping**
- **Preconditions:** Logged in as a **member** (sales persona). A deal owned by a different rep exists.
- **Expected:** The other rep's deal is **not visible**; only owned/unassigned deals appear. Verify both in UI and by direct navigation to the deal's detail URL (should be denied/empty).

---

### 5.5 CSV bulk upload

**TF-CSV-01 — Valid upload**
- **Steps:** Upload a well-formed CSV of deals.
- **Expected:** All rows imported; per-row success shown; deals appear in list.

**TF-CSV-02 — Mixed valid/invalid rows**
- **Steps:** Upload a CSV where some rows have invalid amount/stage/missing name.
- **Expected:** Valid rows imported; invalid rows reported individually with reasons; no partial corruption.

**TF-CSV-03 — Malformed CSV / quoting**
- **Steps:** Upload CSV with quoted commas, embedded newlines, trailing empty lines.
- **Expected:** Parser (RFC-4180-style) handles quoting correctly; no crash.

---

### 5.6 Tasks, notes & comments

**TF-TASK-01 — Create & complete task**
- **Steps:** Create a task with priority/due date/assignee linked to a deal; mark complete.
- **Expected:** Appears on the deal detail page and `/dashboard/tasks`; on completion, `status=completed` and `completed_at` set; activity logged.

**TF-NOTE-01 — Add note**
- **Expected:** Note shows on entity detail (newest first); realtime event emitted.

**TF-COMMENT-01 — Comment with @mention**
- **Steps:** Post a comment mentioning a teammate.
- **Expected:** Comment appears (oldest-first thread); mentioned user receives a notification; typing indicator shows while composing in a second session.

---

### 5.7 Communications & email

**TF-COMM-01 — Folder access (RBAC)**
- **Steps:** Open `/dashboard/communications` as sales persona.
- **Expected:** Redirected/denied (admin/manager only).

**TF-COMM-02 — Draft auto-save**
- **Steps:** As admin/manager, start composing; type and pause.
- **Expected:** Draft auto-saves (debounced); status indicator cycles saving → saved; draft appears in Drafts folder.

**TF-COMM-03 — Multi-tab draft conflict**
- **Steps:** Edit the same draft in two tabs.
- **Expected:** Server version is canonical; the stale tab adopts the server's version without data loss.

**TF-COMM-04 — Failed delivery surfacing**
- **Steps:** Trigger a send failure (invalid SMTP / use `email:test`).
- **Expected:** Message appears in **Failed** folder with a badge; activity reflects `email_failed`.

---

### 5.8 Reports & dashboards

**TF-RPT-01 — Persona-aware home**
- **Steps:** Open `/dashboard` as admin, then manager, then sales.
- **Expected:** Each persona sees its tailored view; sales cannot access team-wide funnels by changing URL params.

**TF-RPT-02 — Report access**
- **Steps:** Open `/dashboard/reports`, `/dashboard/executive`, `/dashboard/command-center` as each role.
- **Expected:** Manager/admin can view reports/executive; command-center is admin-only; sales is denied.

**TF-RPT-03 — Report correctness**
- **Steps:** With known seed data, open pipeline-by-stage and win/loss reports.
- **Expected:** Counts/sums match the seed data; revenue figures correct given minor-unit storage.

**TF-RPT-04 — My Performance**
- **Steps:** Open `/dashboard/my-performance` as a sales rep.
- **Expected:** KPIs scoped to that user; ranking shown; AI coaching scoped to their entities.

---

### 5.9 AI / intelligence

> Run these with `AI_ENABLED=false` (mock) for deterministic assertions; optionally repeat a subset in `live` mode.

**TF-AI-01 — Insight generation & caching**
- **Steps:** Open a deal detail; view its AI summary. Reopen without changing data.
- **Expected:** First view generates (or shows generating); second view is served from cache (no new `ai_invocations` row in live mode for unchanged content).

**TF-AI-02 — Stale regeneration**
- **Steps:** Change the deal (e.g., add a note), reopen.
- **Expected:** Content hash changes → summary marked stale → regenerated asynchronously; page does **not** block waiting on the model; realtime swaps in the new summary.

**TF-AI-03 — Mock mode**
- **Steps:** With `AI_ENABLED=false`, exercise summaries/recommendations.
- **Expected:** Deterministic stub output; full pipeline executes; `ai_invocations` rows recorded with skipped/mock status.

**TF-AI-04 — Token budget**
- **Steps:** Lower the per-tenant daily token limit; exceed it.
- **Expected:** Further calls skipped gracefully (state = budget); UI degrades cleanly; skipped calls recorded.

**TF-AI-05 — Semantic search / Copilot**
- **Steps:** Query the Copilot/search with a phrase matching a deal's content.
- **Expected:** Relevant entity returned via embeddings; results reference the actual CRM records consulted.

**TF-AI-06 — Recommendation feedback loop**
- **Steps:** Accept/dismiss a recommendation.
- **Expected:** Verdict recorded; an observation is written; nightly pattern derivation can consume it (verify a pattern row appears after running the learning job on seeded outcomes).

---

### 5.10 Real-time collaboration

> Requires **two concurrent browser sessions** (different users or tabs).

**TF-RT-01 — Live entity update**
- **Steps:** User A changes a deal stage; observe User B's open board.
- **Expected:** User B's UI updates without refresh.

**TF-RT-02 — Entity viewers presence**
- **Steps:** Both users open the same deal detail.
- **Expected:** Each sees "X is viewing this deal"; presence disappears ~30s after a tab closes.

**TF-RT-03 — Typing indicators**
- **Steps:** User A types in a comment; User B watches the thread.
- **Expected:** "A is typing…" shows; clears shortly after A stops.

**TF-RT-04 — Reconnect & dedupe**
- **Steps:** Hide a tab > 5 min, then refocus.
- **Expected:** SSE reconnects, replays missed events via Last-Event-ID; no duplicate UI entries (events de-duped by UUID).

---

### 5.11 Soft delete & restore

**TF-DEL-01 — Soft delete hides record**
- **Steps:** Delete a deal/company/contact (admin).
- **Expected:** Disappears from normal lists; `deleted_at`/`deleted_by` set; appears under `/dashboard/recently-deleted`.

**TF-DEL-02 — Restore**
- **Steps:** Restore from Recently Deleted (admin).
- **Expected:** Record returns to normal lists; `deleted_at` cleared; activity "restored".

**TF-DEL-03 — Permanent delete (owner only)**
- **Steps:** As admin, attempt permanent delete; then as owner.
- **Expected:** Admin denied; owner succeeds (physical removal).

---

### 5.12 Background jobs & workflows

**TF-WF-01 — Workflow run tracking**
- **Steps:** Trigger a deal won/lost; open `/dashboard/workflows` (admin).
- **Expected:** A run row appears with status (running → completed); deep-link metadata present.

**TF-WF-02 — Local dispatcher fallback**
- **Steps:** Stop the Inngest dev server; trigger an event.
- **Expected:** Workflow still executes in-process (dev); a run is recorded.

**TF-WF-03 — Nightly crons**
- **Steps:** Invoke relationship-signals / stale-deals / analytics-rollup / retention jobs.
- **Expected:** Each completes; relationship counters refresh; stale deals flagged; old runs/notifications trimmed.

---

### 5.13 Global search

**TF-SRCH-01 — Command palette search**
- **Steps:** Press Cmd/Ctrl+K; type a query matching deals/companies/contacts/tasks.
- **Expected:** Results grouped by type (max few per bucket); keyboard navigation works; selecting a result navigates to it.

**TF-SRCH-02 — Search scoping (RBAC)**
- **Steps:** Search as a sales rep for a deal owned by another rep.
- **Expected:** Not returned (sales sees only own/unassigned); workflows bucket only appears for admins.

---

## 6. Multi-tenancy isolation tests (critical)

> These are the most important tests in the suite. Run with **two tenants (A and B)** populated with data.

**TF-ISO-01 — List isolation**
- **Steps:** As a Tenant A user, view companies/contacts/deals/tasks lists.
- **Expected:** Only Tenant A data appears; **no** Tenant B records, ever.

**TF-ISO-02 — Direct-ID access denial**
- **Steps:** As a Tenant A user, navigate to a detail URL using a **Tenant B record's ID**.
- **Expected:** Not found / empty — never the other tenant's data.

**TF-ISO-03 — Search isolation**
- **Steps:** Search for a term that matches a Tenant B record.
- **Expected:** No Tenant B results.

**TF-ISO-04 — AI / embeddings isolation**
- **Steps:** Run semantic search in Tenant A for content that exists only in Tenant B.
- **Expected:** No cross-tenant match; AI summaries/insights never reference other tenants.

**TF-ISO-05 — Activity & realtime isolation**
- **Steps:** Mutate data in Tenant B while a Tenant A session is open.
- **Expected:** Tenant A receives **no** realtime events for Tenant B; activity feed shows only Tenant A.

**TF-ISO-06 — Empty-result trap (negative-of-negative)**
- **Steps:** Confirm Tenant A's own data **does appear** (guards against an over-broad fix that hides everything).
- **Expected:** Tenant A sees all of its own records — isolation must not break legitimate access.

---

## 7. RBAC permission matrix tests

Test each action against each role. **Verify server-side**, not just hidden UI (attempt the action directly).

| Action | owner | admin | manager | member | viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| View companies/contacts/deals | ✅ | ✅ | ✅ | ✅ (scoped) | ✅ (read-only) |
| Create/edit CRM data | ✅ | ✅ | ✅ | ✅ | ❌ |
| Soft-delete CRM data | ✅ | ✅ | ❌ | ❌ | ❌ |
| Restore deleted data | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Permanent (hard) delete** | ✅ | ❌ | ❌ | ❌ | ❌ |
| Invite members | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remove members | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Change roles** | ✅ | ❌ | ❌ | ❌ | ❌ |
| Access communications | ✅ | ✅ | ✅ | ❌ | ❌ |
| Access reports / executive | ✅ | ✅ | ✅ | ❌ | ❌ |
| Access command-center | ✅ | ❌* | ❌ | ❌ | ❌ |
| Access activity log | ✅ | ✅ | ✅ | ❌ | ❌ |

> ✅ = allowed, ❌ = denied. *Command-center is admin-persona (owner/admin); confirm the exact gate in code if a discrepancy appears. For each ❌ cell, the **server** must reject the action even if the request is crafted manually.

**TF-RBAC-01 … TF-RBAC-N:** one test per ✅/❌ cell. Critical cells to never skip:
- Only **owner** can change roles (TF-TEAM-03).
- Only **owner** can hard-delete (TF-DEL-03).
- **member/viewer** cannot soft-delete.
- **sales** cannot access communications/reports/activity.

---

## 8. Non-functional checks

| Area | Check |
|---|---|
| **Performance** | Run `npm run bench`; large lists (from `seed:stress`) paginate within acceptable time; board view capped per column. |
| **Resilience** | App functions in mock AI mode and with Inngest dev server down (local dispatcher). |
| **Cost/observability** | `ai_invocations` records tokens/latency; ops dashboard shows traces/metrics/errors. |
| **Data integrity** | Money round-trips correctly (cents ↔ display); no float drift. |
| **Audit** | Every mutation appears in the activity log with correct actor and action. |
| **Build** | `npm run build` succeeds (note: build runs migration `apply-0024` first). |

---

## 9. Regression checklist before release

- [ ] `npm run selftest` passes (lifecycle, AI, workflows, pagination).
- [ ] `npm run lint` clean; `npm run build` succeeds.
- [ ] Multi-tenancy isolation suite (Section 6) all pass.
- [ ] RBAC matrix (Section 7) — critical cells verified server-side.
- [ ] Deal lifecycle end-to-end: create → progress → won/lost → workflow runs → AI summary updates.
- [ ] CSV bulk upload handles valid/invalid/malformed inputs.
- [ ] Real-time: live update, presence, typing across two sessions.
- [ ] Soft delete → restore → permanent delete (role gates correct).
- [ ] Communications: draft auto-save + failed-delivery surfacing.
- [ ] Search scoping correct for sales persona.
- [ ] New migrations applied cleanly on a fresh DB.

---

## 10. Defect reporting template

```
ID:            (e.g., BUG-2026-001)
Title:         Concise summary
Related TF:    (e.g., TF-ISO-02)
Severity:      Critical / High / Medium / Low
                (Cross-tenant leak or auth bypass = always Critical)
Environment:   dev / staging / prod, AI mode (live/mock), commit hash
Role / persona: owner/admin/manager/member/viewer
Tenant(s):     A / B (for isolation defects)
Preconditions: data state, seed used
Steps:         numbered, reproducible
Expected:      what should happen
Actual:        what happened (include 0-rows-vs-error if RLS-related)
Evidence:      screenshots, activity-log rows, ai_invocations rows, logs/trace id
```

---

*End of document.*
