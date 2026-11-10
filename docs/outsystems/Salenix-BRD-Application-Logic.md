# Salenix CRM — Application Logic BRD & Process Document (OutSystems Rebuild)

| | |
|---|---|
| **Document** | Business Requirements & Process Document — application logic |
| **Product** | Salenix (internal name *Saleinx*, repo `multi-tenant-crm`) |
| **Goal** | Rebuild the existing high-code application (Next.js 16 / React 19 / Drizzle / PostgreSQL / Inngest) in OutSystems with functional parity |
| **Companion document** | `Salenix-BRD-Database.md` — entities, static entities, indexes, triggers → server actions, data migration |
| **Version** | 1.0 — extracted from source on 2026-11-10 |
| **How to read** | `FR-xx` = functional requirement, `BR-xx` = business rule, `[src: path:line]` = where the rule lives in today's code, so a developer can check details |

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Scope, assumptions and parity rules](#2-scope-assumptions-and-parity-rules)
3. [Users, roles, personas and permissions](#3-users-roles-personas-and-permissions)
4. [Target OutSystems architecture](#4-target-outsystems-architecture)
5. [Screen inventory and navigation](#5-screen-inventory-and-navigation)
6. [Functional requirements by module](#6-functional-requirements-by-module)
7. [Background jobs → OutSystems timers](#7-background-jobs--outsystems-timers)
8. [Integrations](#8-integrations)
9. [Non-functional requirements](#9-non-functional-requirements)
10. [Known gaps in the source and decisions needed](#10-known-gaps-in-the-source-and-decisions-needed)
11. [UAT scenarios (parity tests)](#11-uat-scenarios-parity-tests)
12. [Appendix A — formula sheet](#12-appendix-a--formula-sheet)
13. [Appendix B — glossary](#13-appendix-b--glossary)

---

## 1. Executive summary

Salenix is a **multi-tenant B2B sales CRM** built for Indian enterprise sales teams (INR, GST, Indian FY, Lakh/Crore incentives). One deployment serves many workspaces; a person can belong to several workspaces and switch between them.

What the product does:

| Area | Capability |
|---|---|
| **Accounts** | Companies and contacts, custom fields, duplicate detection and merge, Account 360 view |
| **Pipeline** | Deals through Lead → Qualified → Proposal → Negotiation → Won/Lost, with a Hold parking stage; Kanban board and list; stage gates; Won approval; rollback reasons; close-date push tracking and quota de-weighting; offerings catalogue; multi-year contract value split |
| **Deal intelligence** | Health score (0–100), risk score (0–100) with AI explanation, field completeness, heuristic predictions |
| **Forecast & targets** | Forecast categories and rollup, weekly snapshots; annual revenue/margin targets with FY attribution |
| **Incentives** | Per-rep annual variable-pay plans (gate + two slabs + cap + margin rule), calculator, roll-up, bulk changes, nightly computed actuals |
| **Finance** | Proforma invoices with GST (IGST vs CGST/SGST), PDF; payments; credit terms and approval; "credit period vs achievement" collections report |
| **Collaboration** | Tasks (recurring, auto-created by workflows), notes, threaded comments with @mentions, notifications, activity timeline |
| **Communications** | Shared inbox, compose/reply with drafts, outbound email (SMTP/Resend), Gmail read-only sync that auto-attaches emails to deals |
| **Analytics** | Persona dashboards, 8 standard reports with CSV, executive view, command center, my performance, team performance with monthly trend snapshots, chart studio |
| **AI** | Summaries, daily executive brief, risk flags, recommendations, copilot chat over CRM data, semantic search, learning loop |
| **Integration** | Ask Mira (HRMS) connector: PKCE connect, people sync, query/act API, SSO |

---

## 2. Scope, assumptions and parity rules

### 2.1 In scope

Everything listed in §1, all screens in §5, all jobs in §7, the Ask Mira API in §8, and data migration (see the database document §11).

### 2.2 Assumptions

- **Platform:** OutSystems 11 Reactive Web or ODC. Differences are noted where they matter.
- **Authentication:** platform users (or an external IdP). Existing passwords are *not* migrated (scrypt hashes) — users reset at cutover.
- **Multi-tenancy:** explicit `TenantId` on every entity with a mandatory server-side filter (not O11 built-in multi-tenancy, because a user can belong to several workspaces). See database document §3.3.
- **Money:** integer minor units (paise/cents) end-to-end; incentives in exact decimals.
- **Feature flags:** six per-workspace module switches (`WorkspaceSettings`) are kept, so modules can be rolled out per tenant.

### 2.3 Parity rules for the build team

1. **Server-side rules only.** Every rule marked BR must be enforced in a server action, not only in the screen. Today several rules are only in the UI — those are listed in §10 and must be fixed, not copied.
2. **One write path per entity.** Screens, CSV import, timers and the Ask Mira API all call the same Core Service server actions. This is what keeps the governance logic (database doc §9) reliable.
3. **Every user action** writes an `ActivityLog` row (where the source does) and, if realtime is kept, publishes an event.
4. **Messages** shown to users should keep the source wording (quoted in this document) so trained users see no change.
5. **Soft delete** by default. Hard delete is Owner-only.

### 2.4 Technology mapping

| Today | OutSystems |
|---|---|
| Next.js pages (App Router) | Reactive screens in the UI module |
| Server Actions (`"use server"`) | Public server actions in Core Service modules, called from screen actions |
| Route handlers `/api/*` | Exposed REST APIs (Ask Mira, Gmail callback, CSV export, audit-log, 360) or screen data actions |
| Zod schemas | Validation server action per entity (`X_Validate`) + client-side form validation for UX |
| Drizzle + Postgres + RLS | Entities + mandatory `TenantId` filter (database doc) |
| Postgres triggers | Private server actions in the owning module (database doc §9) |
| Inngest events + crons | Timers (scheduled), BPT/Light processes or "event" entities processed by a timer (§7) |
| `step.sleep('7d')` | Store a `ScheduledAction` row with `RunAfter`; a timer picks it up |
| Debounce 5 min per deal | `DealRecomputeQueue` entity keyed by DealId with `DueAt = now + 5 min`; timer processes due rows |
| SSE + `pg_notify` realtime | Reactive polling (e.g. 20–30 s) of a `RealtimeEvent` table, or a WebSocket Forge component; can be phased |
| Supabase Storage (`deal-documents`, invoice bucket) | Binary entity (`DealDocumentFile`) or external S3/Azure Blob via an integration module |
| jsPDF client-side PDF | Server-side PDF (Forge "Ultimate PDF" or similar) using the layout in §6.13 |
| OpenAI / Anthropic SDK | Consume REST API (OpenAI chat + embeddings; Anthropic messages) in integration modules |
| JWT cookie session (7 days) | Platform session; session timeout configured to match policy |
| nodemailer / Resend | OutSystems email (SMTP) or Resend REST |
| Recharts / react-grid-layout | OutSystems charts (OutSystems Charts / Highcharts) and a grid/dashboard Forge component |

---

## 3. Users, roles, personas and permissions

### 3.1 Roles (stored on `Membership.Role`)

| Role | Rank | Intent |
|---|---|---|
| **owner** | 30 | Everything, incl. role changes, hard delete, workspace create/rename/delete, invoice settings |
| **admin** | 20 | CRM data + member management + workspace configuration; cannot change roles |
| **manager** | 15 | Team visibility (reports, team performance, approvals, collections), invite members, assign deals |
| **member** | 10 | Read/write CRM on own and unassigned records |
| **viewer** | 5 | Read-only (reserved — cannot be invited; no write permission) |

Membership status: `active` (only status that grants access), `invited` (unused), `suspended` (set by Ask Mira people-sync).

### 3.2 Personas (UX grouping — never grants permissions)

| Persona | Roles | Effect |
|---|---|---|
| **admin** (label "Administrator") | owner, admin | Full navigation, whole-workspace data |
| **manager** ("Manager") | manager | Team navigation, whole-workspace data (there is **no** reporting hierarchy — a manager sees every rep) |
| **sales** ("Sales") | member, viewer | Personal navigation; data hard-scoped to own + unassigned records |

**BR-RBAC-01 Data scope for the sales persona.** Deals, companies, contacts and tasks are filtered `OwnerId = me OR OwnerId IS NULL` (tasks: `AssignedUserId = me OR NULL`). The filter is applied server-side and cannot be widened by URL/filters. It applies to list, board, export, search, revert and the Ask Mira API. [src: `src/lib/deals/queries.ts:121-130, 491-497`]

**BR-RBAC-02 Linking scope.** When a sales user creates/edits a deal, the linked company and contact must be owned by them or unassigned. [src: `src/app/dashboard/deals/actions.ts:206-268`]

### 3.3 Permission matrix

Implement as a static entity `Permission` + `RolePermission` mapping (or a `HasPermission(Role, PermissionCode)` server function in `Salenix_Common`). Source: `src/lib/rbac.ts:18-109`.

| Permission | owner | admin | manager | member | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| manageMembers, revokeInvitations, removeMembers | ✓ | ✓ | | | |
| inviteMembers | ✓ | ✓ | ✓ | | |
| manageRoles | ✓ | | | | |
| manageCompanies, manageContacts, manageDeals | ✓ | ✓ | ✓ | ✓ | |
| deleteCompanies/Contacts/Deals, restoreCompanies/Contacts/Deals | ✓ | ✓ | | | |
| hardDeleteCompanies/Contacts/Deals | ✓ | | | | |
| assignDeals (set owner to someone else) | ✓ | | ✓ | | |
| approveDeals | ✓ | ✓ | ✓ | | |
| manageForecast | ✓ | ✓ | ✓ | | |
| manageTargets, manageStageGates (+ feature flags), manageOfferings, manageIncentives, manageCollectionSettings | ✓ | ✓ | | | |
| viewTeamIncentives, approveCreditTerms, recordPayments, viewCollections | ✓ | ✓ | ✓ | | |

Additional hard-coded checks:

- Custom fields: owner/admin only. [src: `settings/custom-fields/actions.ts:22-40`]
- Invoice settings and Organizations page: owner only.
- **BR-RBAC-03 Deal owner assignment.** Only owner or manager may set a deal owner to someone else; for any other role, create sets owner = actor and update leaves owner unchanged. A manager may not assign a deal to a user whose role is owner — "Managers cannot assign deals to an owner." (Note: admin is *not* in `assignDeals`.)
- Denied message format: `Permission denied: requires "<perm>" (current role: <role>)`.

### 3.4 Navigation per persona (sidebar)

| Group | admin persona | manager persona | sales persona |
|---|---|---|---|
| Workspace / My Work | Dashboard, Executive, Forecast, Team, Activity | Dashboard, Forecast, Team Performance, Activity | Dashboard, My Deals, Pipeline, At Risk, Tasks |
| Sales | Pipeline, Deals, Approvals, At Risk, Targets, Incentives, Collections, Team Performance, Communications, Reports | Pipeline, Deals, Approvals, At Risk, Targets, Incentives, Collections, My Incentive, Communications, Reports | — |
| CRM | Contacts, Companies, Invoices | Contacts, Companies, Invoices | Contacts, Companies, Invoices |
| Insights | Command Center, Intelligence | — | — |
| Performance | — | — | My Performance, My Targets, My Incentive |
| System / Management / Settings | Workflows, Operations, Settings, Recently deleted | Team, Settings | Personal Settings (Profile) |
| **Owner** (owners only, any persona) | Organizations, Invoice settings | | |

The workspace switcher and "Create workspace" appear only for owners of the active workspace. The sidebar collapses to icons; on mobile it is a drawer.

---

## 4. Target OutSystems architecture

### 4.1 Modules

```
END-USER     Salenix (Reactive app)  ── screens §5, client validation, charts
             Salenix_Admin (optional) ── settings, ops, workflows
CORE         Salenix_Identity_CS   tenants, memberships, invitations, workspace switch, RBAC
             Salenix_Config_CS     org settings, feature flags, custom fields, offerings catalogue, stage gates
             Salenix_Accounts_CS   companies, contacts, dedup, merge, rollups, Account 360
             Salenix_Deals_CS      deals + all governance, approvals, value split, scoring, risk, forecast
             Salenix_Performance_CS targets, incentives engine, team analytics snapshots
             Salenix_Finance_CS    proforma invoices, PDF, payments, credit terms, collections diagnostic
             Salenix_Collab_CS     tasks, notes, comments, notifications, activity log, timeline
             Salenix_Comms_CS      threads, messages, drafts, sending, Gmail ingest, relationship signals
             Salenix_AI_CS         insights cache, budget, prompts, copilot, embeddings metadata, learning loop
             Salenix_Analytics_CS  dashboards, reports (8), chart views, CSV
             Salenix_Jobs          all timers §7, job-run tracking (WorkflowRun)
INTEGRATION  Salenix_AskMira_API (exposed REST) + AskMira_IS
             Gmail_IS, OpenAI_IS, Anthropic_IS, EmailSend_IS, FileStorage_IS, VectorSearch_IS (optional)
FOUNDATION   Salenix_Common  (TenantContext, HasPermission, Money, FiscalYear, Dates, CSV, Errors)
             Salenix_Theme
```

### 4.2 Request context (replaces `tenantTransaction` + RLS)

Every public Core Service action starts with `Salenix_Common.RequireContext()`:

1. Read `ActiveTenantId` from the session; read `GetUserId()`.
2. Load the `Membership(TenantId, UserId)`; it must exist with `Status = active`, otherwise raise `MembershipMissing` (the UI shows a recovery screen with "switch workspace").
3. Return `{TenantId, UserId, Role, Persona}`. All queries filter `TenantId`, plus `DeletedAt = NullDate()` unless `IncludeDeleted`.
4. For timers and webhooks use `RequireSystemContext(TenantId)` with the technical System user (actor shown as "system").

### 4.3 Error handling

Define User Exceptions in `Salenix_Common` so screens can show the same messages: `ValidationError` (with field map), `PermissionDenied`, `NotFound`, `Conflict` (duplicates, stale version), `RollbackReasonRequired`, `GateBlocked` (with failed-rule list and CTAs), `NeedsConfirmation` (e.g. clearing a close date when moving to Lead).

---

## 5. Screen inventory and navigation

Access = persona allowed by the page guard (`requirePersonas`). "all" = any active member.

| # | Source route | OutSystems screen | Access | Purpose |
|---|---|---|---|---|
| 1 | `/sign-in` | Login | public | Email + password, "Forgot password" link, `?reset=1` banner |
| 2 | `/sign-up` | SignUp | public (invite token only) | Invite-only account creation, email locked to invite |
| 3 | `/forgot-password`, `/reset-password` | ForgotPassword, ResetPassword | public | Reset by emailed token (1 h) |
| 4 | `/accept-invite` | AcceptInvite | public | Accept invitation (sign-up, sign-in or one-click accept) |
| 5 | `/select-org` | SelectWorkspace | signed-in | Choose/create workspace |
| 6 | `/sso/askmira`, `/connect/askmira` | AskMiraSSO, AskMiraConnect | public / admin | SSO landing; approve connector |
| 7 | `/dashboard` | Home | all (persona-specific layout) | KPIs, highlights, trends |
| 8 | `/dashboard/deals` | Deals (list) | all | Table, filters, inline edit, CSV upload/export, bulk actions |
| 9 | `/dashboard/deals/board` | Pipeline (board) | all | Kanban by stage, drag to change stage |
| 10 | `/dashboard/deals/[id]` | DealDetail | all (scope rules) | Full deal page (path bar, cards, timeline, tabs) |
| 11 | `/dashboard/deals/approvals` | Approvals | manager, admin | Won deals awaiting approval; bulk approve/reject |
| 12 | `/dashboard/deals/at-risk` | AtRisk | all | Deals by risk score |
| 13 | `/dashboard/companies`, `/[id]` | Companies, CompanyDetail (Account 360) | all | List with rollups; account view |
| 14 | `/dashboard/contacts`, `/[id]` | Contacts, ContactDetail | all | List; contact view |
| 15 | `/dashboard/tasks` | Tasks | all | My/all tasks with filters |
| 16 | `/dashboard/activity` | Activity | manager, admin | Workspace activity feed |
| 17 | `/dashboard/communications`, `/[threadId]` | Inbox, Thread | manager, admin | Shared inbox: Inbox/Sent/Drafts/Failed/Archived |
| 18 | `/dashboard/email` | Compose (legacy) | all | Simple email compose |
| 19 | `/dashboard/targets` | Targets | all (sales sees own row) | Target vs achievement |
| 20 | `/dashboard/incentives`, `/[planId]` | Incentives, IncentivePlan | manager, admin | Roll-up and plan calculator |
| 21 | `/dashboard/my-incentive` | MyIncentive | all | Own non-draft plan |
| 22 | `/dashboard/invoices` | Invoices | all (members see own) | PI list, create/edit drawer, PDF, payments |
| 23 | `/dashboard/invoice-settings` | InvoiceSettings | owner | Seller profiles per state, terms, logo |
| 24 | `/dashboard/collections` | Collections | manager, admin | Credit period vs achievement |
| 25 | `/dashboard/executive` | Executive | manager, admin | One-screen business health |
| 26 | `/dashboard/executive/forecast` | Forecast | manager, admin | Owner × category matrix |
| 27 | `/dashboard/reports`, `/[reportId]` | Reports, Report | manager, admin | 8 reports + CSV |
| 28 | `/dashboard/command-center` | CommandCenter | admin | Predictions, AI flags, recommendations |
| 29 | `/dashboard/intelligence` | Intelligence | manager, admin | AI insights and recommendation verdicts |
| 30 | `/dashboard/my-performance` | MyPerformance | all (self) | Personal KPIs, rank, coaching |
| 31 | `/dashboard/team-performance` | TeamPerformance | manager, admin | Scorecard, pushback, engagement, completeness, trends |
| 32 | `/dashboard/team` | Team | manager, admin | Members, invites, roles |
| 33 | `/dashboard/organizations` | Organizations | owner | Rename/delete owned workspaces |
| 34 | `/dashboard/recently-deleted` | RecentlyDeleted | admin | Restore / permanent delete |
| 35 | `/dashboard/workflows` | Workflows | admin | Job runs |
| 36 | `/dashboard/ops` | Operations | admin | AI usage, job health, email delivery, errors |
| 37 | `/dashboard/settings/*` | Settings (16 sub-screens) | see §6.3 | Profile, appearance, notifications, email sync, organization, pipeline, currency, targets, incentives (+plan, bulk), credit terms, offerings, custom fields, stage gates, data quality, email, AI |

Global elements: command palette search (Cmd+K), notifications bell, workspace switcher, AI copilot panel, theme.

---

## 6. Functional requirements by module

Each module lists the process, the functional requirements (FR), the business rules (BR), validations and the server actions to build. Field limits come from the source Zod schemas.

### 6.1 Authentication and workspace selection

**Process**

```
Visit app ──► signed in? ──no──► Login (?next=<path>)
                 │yes
                 ▼
         active workspace in session? ──no──► Select workspace
                 │yes
                 ▼
            Dashboard (persona layout)
```

| ID | Requirement |
|---|---|
| FR-AUTH-01 | **Login** with email + password. Email is trimmed and lower-cased. Any failure (unknown user, no password set, wrong password) shows the single message **"Invalid email or password."** Empty fields: "Enter your email and password." |
| FR-AUTH-02 | After login the active workspace = the user's first **active** membership ordered by workspace creation date. Redirect to a safe `next` (must start with `/` and not `//`), else Dashboard if a workspace exists, else Select workspace. |
| FR-AUTH-03 | **Sign-up is invite-only.** Checks in order: email already registered → "An account with this email already exists. Sign in instead."; no token → "Sign-up is invite-only. Ask a workspace admin to send you an invitation."; invalid/expired/accepted token → "This invitation is invalid or has expired."; email ≠ invite email → "This invitation was sent to a different email address." The token is validated **before** the user is created. Creates the user (email verified = true), accepts the invite, opens the invited workspace. |
| FR-AUTH-04 | Password rule: minimum 8 characters ("Use at least 8 characters"); names optional, ≤ 100 chars. (Platform password policy may be stricter — decide.) |
| FR-AUTH-05 | **Forgot password** always answers "sent" (never reveals whether the email exists). Token valid **1 hour**, single-use. The email says "Set your password" if the user never had one, else "Reset your password". Reset requires ≥ 8 chars, marks email verified, redirects to Login with "Your password was updated. Sign in with your new password." |
| FR-AUTH-06 | **Session** lifetime 7 days in the source (fixed, not sliding). Roles are re-read from `Membership` on every request, so removing a member takes effect immediately. |
| FR-AUTH-07 | **Select workspace** lists active memberships (name, role). Switching re-validates membership server-side. Subtitle: "Choose a workspace to continue." / "You're not in a workspace yet. Create one to get started." / "…Ask an admin to invite you." |
| FR-AUTH-08 | **Create workspace** — allowed only when the user is **owner of the currently active workspace**. Name 2–80 chars ("Use at least 2 characters"). Creates Tenant (slug = slugified name ≤ 40 chars + "-" + 6 random hex), Membership(owner), seeds the default offerings catalogue (failure is logged, not fatal), **adds the default owner account `info@cgbindia.com` as owner of every new workspace** (created without password if missing — decide whether to keep), then switches to it. |
| FR-AUTH-09 | **Membership missing** (session points to a workspace where the user is no longer active) → recovery screen offering workspace switch. |
| FR-AUTH-10 | Out of scope in source (consider adding with the platform): rate limiting, lockout, MFA. |

**Server actions:** `Auth_Login`, `Auth_SignUpWithInvite`, `Auth_RequestPasswordReset`, `Auth_ResetPassword` (or platform equivalents), `Workspace_ListMine`, `Workspace_SetActive`, `Workspace_Create`.

### 6.2 Team management and invitations

| ID | Requirement |
|---|---|
| FR-TEAM-01 | Team screen (manager, admin personas): member table — avatar, name, email, role badge, status badge, joined date; pending invitations (unaccepted, unexpired, oldest first). |
| FR-TEAM-02 | **Invite** (permission `inviteMembers`: owner, admin, manager). Email valid, ≤ 255 ("Email is too long"); role ∈ admin, manager, member (default member; "Pick a role"). Already a member → "This person is already a member of this workspace." Token = 32 random bytes; store **SHA-256 hash only**; expiry **7 days**. Email subject "Join {workspace} · Saleinx", link `{APP_URL}/accept-invite?token=…`. If the email fails, the invite is still kept. Writes activity `invited` (entity `invitation`). |
| FR-TEAM-03 | **Revoke** invite (owner, admin) — hard delete; activity `invitation_revoked`. *Fix:* show the Revoke button only to users with `revokeInvitations` (source shows it to managers and then fails). |
| FR-TEAM-04 | **Accept invite**: invalid token → "This invitation is invalid or has expired."; signed in as invited email → one-click Accept; signed in as another email → message + Sign out; not signed in → sign-up form with email locked + Sign in link. Accepting upserts the membership as active at the invited role; **an existing owner is never downgraded**. |
| FR-TEAM-05 | **Change role** (owner only). Not on yourself ("You cannot change your own role."), not on owners; targets admin, manager, member. Demoting the last admin/owner is blocked — *fix:* return an error instead of the source's silent success. Activity `role_changed {to}`. |
| FR-TEAM-06 | **Remove member** (owner, admin). Not yourself ("Use the workspace switcher to leave the workspace instead."); removing an admin/owner needs an owner ("Only an owner can remove an admin or owner."); never the last admin/owner ("Cannot remove the last admin or owner. Promote another member first."). Deletes the membership; the person's records keep their owner id. Activity `member_removed`. |
| FR-TEAM-07 | New-member onboarding job writes an activity note "Onboarding queued for {email} ({role})…" (§7). |

**Decision needed:** the source lets a manager invite someone as **admin**. Recommended: managers may invite only `member`/`manager`.

### 6.3 Settings

Organisation settings live in one `OrganizationSettings` row per workspace (created on first read, every save stamps `UpdatedBy`). Each section saves separately. **Fix:** every save action must check the role (the source checks only membership — any member could call them).

| Screen | Who | Fields and rules |
|---|---|---|
| **Profile** | all | Read-only: display name (first + last → username → email → "Unnamed"), email, user id, workspace name |
| **Appearance** | all (workspace defaults should be admin-only) | Personal theme light/dark/system (browser only). Workspace: default theme (light default), density comfortable/compact, reduced motion |
| **Notifications** | admin | Workspace toggles (all default on): task assignments, AI recommendations, workflow notifications, email events, realtime updates |
| **Email sync** | each user | Gmail connect/disconnect (needs flag `emailSyncEnabled`); shows connected email, status, last sync, last error; exclusions: ≤ 100 domains (1–255 chars), ≤ 200 addresses (1–320), lower-cased. Disconnect deletes the connection and token; captured emails stay |
| **Organization** | manager, admin | Display name ≤ 200 (blank → workspace name); locale (en-US, en-IN, en-GB, en-IE, en-AE, en-SG, en-CA, en-AU, ja-JP); timezone (13 options, default UTC) |
| **Pipeline** | manager, admin | Default deal stage (default lead; **hold must be excluded** — DB rejects it); default report range (default last_30d); fiscal year start month 1–12 (default 1; UI marks April "Indian FY", July "US Federal FY"); dashboard metrics (CSV ≤ 400, default `pipeline,won,wonRecent,activity`); unit pricing on/off; stage probabilities 0–100 per editable stage (step 5) |
| **Currency & locale** | manager, admin | Default currency (3 letters, upper-cased, default INR; options USD, INR, EUR, GBP, AED, SGD, CAD, AUD, JPY), currency locale (2–20 chars), compact numbers (₹51L / $1.2M). Existing deals keep their own currency |
| **Sales targets** | admin | See §6.11 |
| **Incentives** (+ plan editor, bulk) | admin | See §6.12 |
| **Credit terms** | admin | Standard credit days (default 30), material excess days (default 15), 0–730 server / 0–365 UI and DB. See §6.14 |
| **Offerings** | admin | Enable switch; catalogue CRUD (§6.7.10) |
| **Custom fields** | owner, admin | See below |
| **Stage gates** | admin | Enable switch; rules (§6.7.6) |
| **Data quality** | admin | Duplicate pairs + merge (§6.6) |
| **Email** | admin | Sender name ≤ 200, sender email, reply-to (valid or empty), auto-BCC (CSV ≤ 400), default signature ≤ 2000, email tracking on/off |
| **AI** | admin | AI enabled (default on), aggressiveness conservative/balanced/aggressive, insight refresh on_change/hourly/daily/manual; shows live vs mock mode |
| **Organizations** | owner | List owned workspaces; rename (2–80, must own that workspace); delete — type the exact name, shows counts (companies, contacts, deals, invoices, tasks, members), cascades everything, switches session to another workspace or Select workspace |

**Feature flags (`WorkspaceSettings`, all default off):** stageGatesEnabled, dealScoringEnabled, emailSyncEnabled, forecastsEnabled, dedupEnabled, offeringsEnabled. The source has UI switches only for stage gates and offerings; **add an admin "Modules" screen** for all six.

#### 6.3.1 Custom fields

| ID | Rule |
|---|---|
| BR-CF-01 | Entities: deal, company, contact. Types: text, number, date, select (Dropdown), boolean (Checkbox). |
| BR-CF-02 | Label 1–60 required. Options ≤ 50, each 1–60, de-duplicated; select needs ≥ 1 ("Add at least one option for a dropdown field."); other types have no options. Boolean is never required. |
| BR-CF-03 | Key generated from label: lower-case, non-alphanumerics → `_`, ≤ 50 chars, `field` if empty; on clash append `_2`, `_3`… Key and type cannot change after creation. |
| BR-CF-04 | Archive/unarchive (values kept, hidden from forms). Move up/down swaps sort order with the nearest active neighbour. New field sort = max + 1. |
| BR-CF-05 | Value validation: required non-boolean empty → "`{label}` is required"; text trimmed, ≤ 2000; number finite ("must be a number"); date `YYYY-MM-DD` ("must be a valid date"); select must be an option ("pick a valid option"); boolean true for true/'true'/'on'/'1'; empty → not stored. Display booleans as Yes/No. |
| BR-CF-06 | Custom-field keys can be required by a stage gate (`field_required`) and by completeness scoring (required fields always applicable). |

### 6.4 Companies

| ID | Requirement |
|---|---|
| FR-CO-01 | **List** with rollup columns (database doc §9.7): deal count, open deals, won deals, open pipeline value, won lifetime value, top stage, contact count, last activity. Zero shows "—"; values shown only when the count > 0. Sales persona: own + unassigned. |
| FR-CO-02 | **Filters:** mine, unassigned, has open deals, recent activity (chip 14 d), created within (chip 30 d), stale (last activity older than N days, default 30; never-touched counts as stale), min open deals, min won deals. **Sorts:** recent, deals, pipeline, won, activity. **Bulk:** reassign owner, soft delete. |
| FR-CO-03 | **Create** (`manageCompanies`): name 1–200 required, domain ("Website") ≤ 255, industry ("Type") ≤ 100, owner optional, custom fields. Compute `NormalizedName` (§6.6). If dedup is on and similar companies were shown, set `DedupOverride = true` and log `dedup_override`. Activity `created`; queue embedding. |
| FR-CO-04 | **Update / inline patch**: same fields. *Fix:* recompute `NormalizedName` on rename (source doesn't). Activity `updated`. |
| FR-CO-05 | **Change owner** (`manageCompanies`): activity `owner_changed {from,to}`; notify new owner unless they are the actor. *Fix:* inline/bulk owner changes must go through this same action (source skips the activity/notification). |
| FR-CO-06 | **Soft delete** (owner, admin), **restore** (owner, admin), **hard delete** (owner). Messages: "… not found or already deleted." |
| FR-CO-07 | **Account 360** (company detail; deleted or merged → not found): header (industry, domain, deal and contact counts); inline-editable name/website/type; owner card; created/updated; custom fields; **contacts** top 5 by updated (total shown, "View all" → contacts filtered by company); **deals** top 5 by updated **including won/lost** (name, stage, amount, currency, close date; "View all"); **timeline** ≤ 150 items merging activity, notes, comments, emails from the company plus up to 500 of its deals and 500 contacts; tasks panel, notes, comments, email composer. API limits: rollup ≤ 50, timeline ≤ 500. |

### 6.5 Contacts

| ID | Requirement |
|---|---|
| FR-CT-01 | Fields: first name ≤ 100, last name ≤ 100, email (valid, ≤ 255), phone ≤ 50, title ≤ 100, company (must be in the workspace and not deleted), owner, custom fields. |
| BR-CT-01 | **Identity rule:** at least one of first name, last name or email — "Keep a name or email on the contact." (checked against the merged result on patch). |
| BR-CT-02 | **Email uniqueness:** creation is blocked when an active contact already has the same email (case-insensitive), regardless of the dedup flag; show a link to the existing contact. *Fix:* apply on update/patch too. |
| FR-CT-02 | List: sales persona own + unassigned; same delete/restore/owner rules as companies; detail page with timeline, tasks, notes, comments, email. |

### 6.6 Duplicate detection and merge (flag `dedupEnabled`)

**Normalisation** (implement in `Salenix_Common.Normalize*`):

| Value | Steps |
|---|---|
| Company name | Unicode NFKD → remove combining marks (U+0300–U+036F) → lower-case → replace `[^a-z0-9\s]` with space → collapse spaces, trim → remove whole-word suffixes `ltd, limited, pvt, private, llp, inc, incorporated, corp, corporation, co, company, plc, llc, gmbh, sarl, bv, ag` → if empty, use the pre-suffix form. Example "Acme Pvt. Ltd." → "acme" |
| Contact name | `first + " " + last`, same steps without suffix removal |
| Email | trim + lower-case |

| ID | Rule |
|---|---|
| BR-DD-01 | Similarity threshold **0.55** (trigram similarity or word-similarity). Soft-deleted and merged rows are always excluded. See database doc §10.2 for the OutSystems implementation choice. |
| BR-DD-02 | **Company create:** normalised name ≥ 2 chars; match = exact normalised name OR similarity ≥ 0.55; exact first, then by score; top 5; warning only (debounce ~300 ms). |
| BR-DD-03 | **Contact create:** exact email = hard block (BR-CT-02); name similarity ≥ 0.55 (normalised ≥ 3 chars), top 5 = warning only (debounce ~400 ms). |
| FR-DD-01 | **Data quality screen** (admin): company pairs (same normalised name or ≥ 0.55), contact pairs (same email or name ≥ 0.55), up to 100 pairs. |
| FR-DD-02 | **Merge** (owner/admin; one human click, never automatic): winner ≠ loser, both active. In one transaction re-point all children (database doc §9.10), delete the loser's derived AI/relationship rows, soft-delete the loser with `MergedIntoId`, write `MergeAudit` (full loser snapshot + counts) and activity `merged` on the winner. **The winner's field values are kept as-is** (no field-level merge). Reversal is manual from the snapshot. |

### 6.7 Deals and pipeline (core module)

#### 6.7.1 Stages

```
 lead ──► qualified ──► proposal ──► negotiation ──► won
   ▲          ▲             ▲             ▲           │
   └──────────┴─────────────┴─────────────┘ rollback (needs reason)
 Any stage ──► lost          Any stage ◄──► hold (parking; needs reason + revisit date)
```

- Funnel rank: lead 1, qualified 2, proposal 3, negotiation 4, won 5. **Hold and Lost are unranked** (parking states). Any stage may move to any stage, subject to the rules below and stage gates. There is no fixed transition matrix.
- Default probabilities (overridable per workspace for lead, qualified, proposal, negotiation, hold): lead **10**, qualified **30**, proposal **60**, negotiation **80**, hold **40**, won **100** (fixed), lost **0** (fixed).
- Forecast category derived from stage: lead/qualified → pipeline; proposal → best_case; negotiation → commit; won → closed_won; hold/lost → omitted.

#### 6.7.2 Stage requirements matrix

| Stage | Close date | Margin % | Other |
|---|---|---|---|
| lead | **Forbidden** (BR-DL-R0) | optional | Moving a dated deal to Lead clears the date after user confirmation |
| qualified | optional | **required** (> 0) | |
| proposal | **required** (BR-DL-R1) | required | |
| negotiation | required | required | |
| won | required | required | Won approval (§6.7.9); `ClosedAt` set |
| hold | optional | optional | Hold reason + revisit date required; only from board/detail "Put on hold" |
| lost | optional | optional | Lost reason required (*fix:* enforce server-side); `ClosedAt` set |

#### 6.7.3 Business rules (enforce in `Deal_ValidateRules`, used by every write path)

| ID | Rule | Message |
|---|---|---|
| BR-DL-R0 | A deal in **Lead** cannot have an expected close date. | "A deal with a close date can't be in Lead — move it to Qualified or a higher stage." |
| BR-DL-R1 | Close date required in **proposal, negotiation, won** (blank = missing). | "An expected close date is required to be in {Stage}." |
| BR-DL-R2 | A **rollback** (both stages ranked and new rank < old rank) needs a reason code from RollbackReason (requirement_changed, budget_lost, champion_left, wrong_stage_advance, competitor_reintroduced, other) + optional note ≤ 1000. Moves to/from Hold or Lost are never rollbacks. | "Moving a deal backward needs a reason." |
| BR-DL-R3 | The close date cannot be **cleared** while the deal is (or is moving to) proposal/negotiation/won. Changing it to another date is allowed (it is a push). | "The close date can't be cleared while the deal is in Proposal or Negotiation. Set a new date, or move the deal back a stage with a reason." |
| BR-DL-M1 | Margin % required unless stage ∈ lead, hold, lost; must be > 0 and ≤ 100. Stored as basis points: `MarginBps = round(pct × 100)`. | "Margin % is required from Qualified onwards." / "Margin must be greater than 0" / "Margin cannot exceed 100%" |
| BR-DL-L1 | Moving to Lost requires a lost reason (trim, ≤ 1000). | "A reason is required when marking a deal Lost" |
| BR-DL-H1 | Moving to Hold requires `HoldReason` + `HoldRevisitOn` (+ optional note ≤ 1000). *Recommended addition:* revisit date must be in the future. | "Moving to Hold needs a reason and a revisit date." |
| BR-DL-H2 | The full edit form cannot put a deal on Hold. | "Put a deal on Hold from the pipeline board — it needs a reason and a revisit date." |
| BR-DL-O1 | Offerings rule (flag on): new deal needs ≥ 1 offering; a tagged deal can't be emptied; with > 1 tag exactly one is primary (a single tag is primary automatically). | "Pick at least one offering — what is this deal selling?" / "Mark one offering as primary." / "This deal is already tagged, so it can't be left with no offering…" |
| BR-DL-A1 | Amount ≥ 0, ≤ 999,999,999,999 (major units). With unit pricing: `AmountMinor = toMinor(UnitPrice) × Quantity` and the typed amount is ignored. If unit pricing is on for the workspace (or the deal already has unit price + qty), direct amount edits are rejected. | "Amount cannot be negative" / "Amount is set by Per Unit Price × Qty on the deal." / "Set both a per-unit price and a quantity." |
| BR-DL-G | Governance on every write (database doc §9.2–9.3): close-date push counting, `TotalSlipDays`, `OriginalCloseDate`, rollback count, audit log, `QuotaWeight = 0.50 when PushCount > 3`. | |

#### 6.7.4 Deal form fields

| Field | Rule |
|---|---|
| Name | required, trim, ≤ 200 ("Name is required") |
| Description | ≤ 2000, empty → null |
| Stage | DealStage |
| Deal type | optional: New Logo, Renewal, Expansion, Upsell |
| Amount / Unit price / Quantity | BR-DL-A1; quantity integer 0–1,000,000 (form) / 0–100,000,000 (inline) |
| Margin % | BR-DL-M1 |
| Currency | USD, EUR, GBP, INR, CAD, AUD, JPY (default = workspace default, INR) |
| Expected close date | `YYYY-MM-DD` |
| Company / Contact (linked records) | company must exist, not deleted; contact must belong to the chosen company when both set; sales persona scope BR-RBAC-02 |
| Company name / contact name / contact email (free text) | ≤ 200; email pattern `^[^@\s]+@[^@\s]+\.[^@\s]+$`. Used when not linked; list shows `COALESCE(company name text, linked company name)` |
| Owner | BR-RBAC-03 |
| Next step, Competitor, Source | detail page, ≤ 2000, empty → null. Source suggestions: Outbound, Referral, Inbound-Website, Partner, Other |
| Custom fields | §6.3.1 |
| Offerings | §6.7.10 |

#### 6.7.5 Create deal — `Deal_Create` (permission `manageDeals`)

1. Validate form; apply R0, R1, M1, L1 (if created at Lost), O1.
2. Resolve links and owner (BR-RBAC-02/03); validate custom fields.
3. Compute amount (BR-DL-A1) and `MarginBps`; `ClosedAt = now` if won/lost; Won approval (§6.7.9).
4. In one transaction: if stage ≠ lead evaluate **stage gates** as a `lead → stage` transition using the form values (count-based rules see 0); insert the deal (`ForecastCategory` derived, `UpdatedBy` = actor, governance init — database doc §9.1/9.2); insert offerings (active ones only; none valid → roll back with the offering message); activity `created {name, stage}`.
5. After commit: queue health recompute (reason `created`), queue embedding, realtime `deal.created`.

#### 6.7.6 Stage gates (flag `stageGatesEnabled`)

Admin-defined **entry** requirements per stage. Lead cannot be gated ("Lead is the entry stage and cannot be gated."). One rule per (stage, rule type); active/inactive; severity **block** (rejects) or **warn** (allows + writes `gate_warning` activity listing failed rules).

| Rule type | Config (admin) | Passes when | Default config |
|---|---|---|---|
| field_required | fields ≥ 1 of: contact_id, company_id, competitor, next_step, expected_close_date, source, deal_type, description, amount, or a custom-field key | each field non-empty (amount > 0; custom non-null/non-blank) | contact_id |
| min_stakeholders | count ≥ 1 | DealContact count ≥ N | 1 |
| min_activities | count ≥ 1, types ⊆ email, call, meeting | Σ activities of those types ≥ N. Mapping: `call_logged`→call, `meeting_logged`→meeting, `email_sent`/`email_synced`→email; **completed tasks of type call/email/meeting also count** | 1, all types |
| amount_required | min ≥ 0 (major units) | AmountMinor ≥ toMinor(min, deal currency) | 1 |
| task_complete | task type (call, email, meeting, internal, followup) | a completed task of that type exists on the deal | call |
| custom_note | prompt 1–500 | the user typed a gate note (≤ 2000) at the transition | "Why are we confident?" |

- Evaluated at **every** stage-mutation site: create, full edit, board drag/path bar, CSV import, Ask Mira `deal.stage`. When the stage change rides on a form save, evaluate against the post-edit values.
- Blocked result: "Can't move to {Stage}: N requirement(s) not met." with per-rule fix CTAs (slide-over on the board). Unknown rule type passes (fail-open).

#### 6.7.7 Change stage (board drag / path bar) — `Deal_ChangeStage`

Inputs: DealId, NewStage, LostReason ≤ 1000, GateNote ≤ 2000, HoldReason, HoldRevisitOn, HoldNote ≤ 1000, ClearCloseDate flag, RollbackReason, RollbackNote ≤ 1000.

Ordered checks (each returns a specific response the UI handles):

1. Target Hold → BR-DL-H1.
2. Target Lead and the deal has a close date and not `ClearCloseDate` → return **NeedsCloseDateClear** (UI confirms, retries; date set to NULL).
3. Same stage → no-op.
4. Rollback without reason → **NeedsRollbackReason** (UI shows reason picker with from/to).
5. R1 on the resulting date → **NeedsCloseDate** (a stage move cannot supply a date; user must edit the deal).
6. Margin required for target and `MarginBps` is null → blocked with CTA "Set margin".
7. Stage gates → warn writes `gate_warning`; block returns **GateBlocked**.
8. Target Lost → BR-DL-L1.

Update: stage; `ClosedAt` set on entering won/lost, cleared on leaving; `LostReason` set when target is lost else null; Lead target → close date null; approval transition (§6.7.9); forecast category re-derived unless overridden; hold fields set on entering Hold, cleared otherwise; governance (rollback reason passed in).

Side effects: activity `stage_changed {from, to, reason, rollback, rollbackReason, rollbackNote}`; agent observation `deal.won` (+1) / `deal.lost` (−1) / `deal.stage_changed`; realtime; after commit — notify the owner `deal_won`/`deal_lost` ("Deal won: {name}" / "Deal lost: {name}") when the actor is not the owner; trigger deal-won / deal-lost workflows (§7); queue embedding + health recompute.

> **Parity fix:** the source's full-form update does not fire the won/lost workflows or notifications — only the board does. In OutSystems, fire them from the shared stage-change logic so every path behaves the same.

#### 6.7.8 Full edit — `Deal_Update` (`manageDeals`)

Same validations as create plus: R3 against the saved stage; rollback reason if backward; gates if stage changed; Hold not allowed (BR-DL-H2). Writes all form fields; leaving Hold clears hold fields; offerings synced (§6.7.10). Activity `stage_changed` if the stage changed, otherwise `updated`. *Source quirk to avoid:* the source clears the free-text company/contact name and email on full save — keep them unless the user changed them.

#### 6.7.9 Won approval (role-based — there is **no margin-threshold approval** in the source)

| Transition | Result |
|---|---|
| Enter Won, actor has `approveDeals` (owner/admin/manager) | ApprovalStatus = **approved**, ApprovedBy = actor, ApprovedAt = now |
| Enter Won, actor is member | **pending** |
| Leave Won | none / null / null |
| Stay Won (edit) | unchanged |
| **Approve** (`approveDeals`; only if won + pending, else "This deal is not awaiting approval.") | approved; activity `deal_approved` |
| **Reject** (`approveDeals`; reason ≤ 500) | stage → **negotiation**, `ClosedAt` null, ApprovalStatus = rejected, system rollback reason `approval_rejected` with the note; activity `deal_rejected`. The `rejected` marker clears to `none` on the next stage move |
| Bulk approve / reject | 1–200 ids ("Select at least one deal"); skips ids not won + pending; returns count |

**BR-DL-Q1 Quota credit:** approval `none` and `approved` count toward targets/incentives; `pending` and `rejected` are withheld and disclosed ("{amount} from N won deals awaiting approval — not counted").

Approvals screen: awaiting (won + pending, newest close first, ≤ 200) and recently decided (≤ 50).

#### 6.7.10 Offerings (flag `offeringsEnabled`)

- **Catalogue** (admin, `manageOfferings`): name 1–120, unique ignoring case ("Give the offering a name" / "Keep the name under 120 characters"); category Product/Service ("Pick Product or Service"); active flag (**retire, never delete**); sort order (new = max + 10; reorder sends the whole category, 1–200 ids, respaced by 10).
- Default seed for new workspaces — Products: SafeOps360, Expenses Tool, CRM (Saleinx), AnytimeHire, ProcureFlow, VisitOS, Cadence, LUMINEX, Velantis. Services: Recruitment, Contract Manpower, Implementation Services, DC Support, Infra Support.
- **Deal tagging** (`manageDeals`): add (active only; first tag becomes primary; duplicate → "That offering is already on this deal."), set primary (one per deal), remove (refused if it would leave none; removing primary promotes the next). Kept tags may be retired offerings; new tags must be active ("One of those offerings is no longer available…").
- Flag off: everything hidden and inert, data kept; actions refuse with "Offerings have been turned off for this workspace by an admin…".
- Untagged deals show "Uncategorized". Report: Funnel by offering (§6.17).

#### 6.7.11 Contract value split (TCV breakdown)

Record-only grid of **elements (≤ 12) × contract years (≤ 10)**; never changes the deal amount.

| Rule | Detail |
|---|---|
| Elements | Component: license, implementation, support, AMC, training, hardware, other (other needs a label ≤ 60); billing type one-time or recurring; consistent across years |
| Years | Anniversary-based: year *i* = [start + (i−1) years, start + i years), end exclusive; Feb 29 → Feb 28 in non-leap years; every element uses the same year dates |
| Auto-fill | One-time → whole amount in year 1. Recurring → `spreadEvenly(total, n)`: base = floor(total / n), **remainder to year 1** |
| Default seed | One recurring `license` element carrying the whole deal amount |
| Validation | ≥ 1 row; indexes contiguous from 1; no duplicates; valid enums; dates valid with end > start; amounts integer ≥ 0; grid complete; **Σ cells = deal amount exactly** (else "short of" / "exceeds" with the signed difference) |
| Save | Empty array clears the split; otherwise delete-then-insert; activity `value_split_changed {years, elements, start, total, currency}` |
| FY display for Support & AMC | Each contract-year amount is 12 equal months; month k of year y → calendar month → FY using the workspace FY start month; share = round(amount × months / 12), **last FY touched takes the remainder**. Example: contract year starting 1 Nov 2026, April FY → 5 months in FY2026–27, 7 in FY2027–28 |
| FY attribution for targets | Different rule — **day-overlap proration for all components** (§6.11) |

#### 6.7.12 Stakeholders (buying committee — `DealContact`)

- Add existing contact (role decision_maker / influencer / champion / blocker / other, default other); primary if requested or first; duplicate → "That contact is already on this deal."
- Create-and-link a new contact (first/last ≤ 120, email ≤ 255, phone ≤ 60, title ≤ 160; name or email required; owner = actor).
- Change role; set primary (exactly one); remove (removing the primary promotes the next).
- Each change: activity `updated {field: stakeholder}` + health recompute.
- `Deal.ContactId` (primary contact on the form) is separate from the stakeholder list.

#### 6.7.13 Documents

- Upload ≤ **15 MB**; types: pdf, jpeg, png, webp, gif, txt, csv, doc, docx, xls, xlsx, ppt, pptx; category proposal/contract/pricing/other (invalid → other).
- Storage path `{tenant}/{deal}/{uuid}-{sanitised name}` (name sanitised to `[a-zA-Z0-9._-]`, last 80 chars). Activity `updated {field: document}`. Delete removes row + file (no activity).

#### 6.7.14 Inline edit (list cells) — `Deal_Patch`

Only fields present are written: name, amount, currency, close date (+ optional change reason ≤ 500 for the push log), margin, deal type, unit price, quantity, company/contact free text, contact email, links, owner. Stage is not patchable. Rules: owner change needs owner/manager; amount rule BR-DL-A1; R0/R1/R3 against the current stage; unit price/qty missing side filled from the stored row. Activity only for owner change (`owner_changed`) in the source — *recommended:* also log `updated` for audit parity.

#### 6.7.15 Change owner — `Deal_Assign` (`assignDeals`)

No-op if unchanged; activity `owner_changed {from,to}`; if the new owner ≠ actor: notification "You now own {name}" + email "You've been assigned: {name}".

#### 6.7.16 CSV bulk upload (`manageDeals`)

| Rule | Detail |
|---|---|
| File | ≤ 2 MB, ≤ **1000** data rows, header row with `name` required |
| Headers (case/space-insensitive aliases) | name/dealname · description/notes/details · stage · amount/value · currency · marginpct/margin/margin%/marginpercent/grossmargin · expectedclosedate/closedate/expectedclose · companyname/company · lostreason/reason/lossreason |
| Row rules | blank stage → lead; amount ≥ 0 (blank 0); blank currency → workspace default; margin strips `%`, > 0 ≤ 100, required unless lead/hold/lost; date `YYYY-MM-DD` + R0/R1; lost reason required for lost; company as free text; owner = uploader |
| Gates | evaluated per row as `lead → stage`; blocked rows reported |
| Result | partial success `{inserted, skipped, errors[{row, message}]}` |
| *Parity fixes* | source sets no approval for Won rows (counts without approval), no forecast category, no offerings, no events/score — the OutSystems import should call the same `Deal_Create` logic per row |

#### 6.7.17 Export CSV

Any member; same filters, search and persona scope as the list; ≤ 10,000 rows; UTF-8 with BOM, CRLF; file `deals-YYYY-MM-DD.csv`. Columns: Name, Stage, Amount (major, 2 dp), Currency, Company, Contact, Contact Email, [Offering (primary or "Uncategorized"), Offering Category, Offering Count — if enabled], Owner, Close Date, Forecast Category, Health Score, Health Band, Approval, Next Step, Competitor, Source, Created, Updated; if any deal has a split: Contract Start, Contract Years, Contract Elements ("Element: total; …"), Year 1 Value … Year N Value.

#### 6.7.18 List and board

- **Filters** (AND between groups, OR within): stage (multi), amount min/max, close from/to, stale (not won/lost and not updated for N days, default 14), company (by name, linked or free text), mine, unassigned, owner (multi), approval pending/approved (implies won), score band, revisit due (hold + revisit ≤ today), slipped (push count ≥ 1), missing field (owes and not filled — §6.8.3), risk elevated/high, offering (any tag), uncategorized. Offering filters dropped when the flag is off.
- **Sort:** recent (created desc) or risk (score desc; unscored excluded). Search: name contains.
- **Board:** 7 columns, **50 cards per column** with "load more" (ordered updated desc, Id desc); per-column totals cover all matching deals: count, Σ amount, **weighted = round(Σ amount × stage probability / 100)**, slipped count/amount. Empty Hold column hidden; non-empty Hold renders as a collapsed lane (count + total). Cards show health band border/chip, "On hold" chip, slip badge.
- **Slip severity:** none (no pushes); **severe** if pushes ≥ 3 or slip days ≥ 30; else watch. **Overdue:** has date, not won/lost, date < today. Tooltip when de-weighted: "Counted at 50% toward quota — pushed N× (more than 3)."
- **Temporary cleanup action** "Revert Qualified → Lead" (1–200 ids): only qualified deals; sales scope; gate qualified→lead; system rollback reason `lead_close_date_cleanup` ("Bulk revert to Lead — expected close date cleared"); clears close date; returns moved/skipped/blocked. Decide whether to keep it.

#### 6.7.19 Deal detail page

Path bar (lead → qualified → proposal → negotiation → won) with stage chevrons; cards: summary (AI), details, value split, offerings, stakeholders, documents, health score (sparkline + reasons), risk, completeness, credit terms, forecast category; tabs: timeline, tasks, notes, comments, emails, **audit log** (keyset, 50 per page, max 200; push count, rollback count, quota weight, counts per change type, entries with actor names), **close-date history** (≤ 200 changes: original vs current date, push count, total slip days, last pushed, each change with old/new/by/reason/is-push).

Actions on the page (`manageDeals`):

- **Log activity:** type call or meeting, date (default today), notes ≤ 4000 → activity `call_logged`/`meeting_logged` + recompute.
- **Edit next step / competitor / source:** activity `updated {field}` + recompute.
- **Forecast category override** (`manageForecast`): pick a category → `ForecastCategoryOverridden = true`; "Auto" → re-derive from stage, overridden = false; activity `updated {field: forecast_category}`.
- **Generate AI summary** (cached by source hash; "force" regenerates).

#### 6.7.20 Delete / restore

Soft delete (owner, admin) → activity `deleted`; restore (owner, admin) → `restored` + re-embed; hard delete (owner) → removes the deal and all children (stage history, audit, date changes, stakeholders, documents, splits, offerings). See §6.21.

### 6.8 Deal intelligence

#### 6.8.1 Health score (flag `dealScoringEnabled`)

Deterministic 0–100, start at **50**, add deltas, clamp. Scored stages: lead, qualified, proposal, negotiation (won, lost and hold are not scored).

| Signal | Condition | Δ |
|---|---|---|
| activity_none | no genuine activity ever | −25 |
| activity_recent | last genuine activity ≤ 7 days | +15 |
| activity_ok | 8–14 days | +5 |
| (neutral) | 15–21 days | 0 |
| activity_stale | > 21 days | −20 |
| stage_on_pace | time in stage ≤ median (median > 0) | +10 |
| stage_stalled | time in stage > 2 × median | −15 |
| close_overdue | expected close < today | −20 |
| close_imminent | 0–30 days away and stage ∈ proposal/negotiation/won | +10 |
| has_stakeholders | ≥ 1 DealContact | +10 |
| has_next_step | next step not blank | +5 |
| tasks_overdue | any open task due < today | −10 |
| tasks_on_track | else, open tasks > 0 | +5 |
| no_amount | amount = 0 | −15 |

- Bands: **≥ 70 strong, ≥ 40 moderate, else at_risk**.
- Genuine activity = `call_logged`, `meeting_logged`, `email_sent`, `email_synced` + completed call/email/meeting tasks.
- Stage median = median of closed `DealStageHistory` intervals for that stage in the workspace, used only with ≥ **10** samples; else fallback days: lead 14, qualified 14, proposal 21, negotiation 14, hold 30, won 14, lost 14.
- Persist: append `DealScore` (score, band, reasons) and update `Deal.HealthScore/HealthBand` **without** touching `UpdatedAt`.
- Recompute: queued with a **5-minute per-deal debounce** on create, update, stage change, field edit, activity, stakeholder, task change, Gmail sync; plus nightly at 01:00 UTC.

#### 6.8.2 Risk score (higher = worse)

Open deals only (not won/lost/hold). Five groups, maxima sum to 100:

| Group (max) | Points |
|---|---|
| Pushback (30) | push count ≥ 4: 26, = 3: 20, = 2: 12, = 1: 6; plus slip days ≥ 60: +8, ≥ 30: +4; cap 30 |
| Silence (25) | days since `UpdatedAt`: ≥ 60: 25, ≥ 30: 20, ≥ 14: 15, ≥ 8: 6 |
| Completeness (20) | filled/applicable ratio at current stage: < 0.25: 20, < 0.5: 15, < 0.75: 10, < 0.9: 5 |
| Time in stage (15) | time in stage / median: > 2: 15, > 1.5: 10, > 1: 5; abstain if median < 5 days or time = 0 |
| Age (10) | deal age / average won cycle: > 2: 10, > 1.5: 7, > 1: 4 (average won cycle used with ≥ 10 won deals, else 90 days) |

- Bands: **≥ 60 high, ≥ 30 elevated, else low**.
- Nightly 01:30 UTC: upsert `DealRiskScore` per deal, prune closed/held/deleted, then **AI explanation** (Anthropic, ≤ 25 deals per tenant per run, highest score first, only when the explanation is empty and score > 0, ≤ 300 tokens). Cache key = hash of the bucketed signals; explanation cleared when the hash changes. **Grounding check:** every number in the AI text must appear in the input, otherwise use the fallback sentence (top 3 factor details joined by "; ", or "No risk signals on this deal.").
- At Risk screen: min score default 30, ≤ 100 rows (max 300), sorted score desc then amount desc.

#### 6.8.3 Field completeness (stage-aware)

A field applies when the deal's stage rank ≥ the field's "from rank" (hold and lost count as rank 1).

| Field | From rank | Filled when | Amber / green % |
|---|---|---|---|
| Company | 1 | linked company or company name text | 60 / 90 |
| Contact | 1 | linked contact or contact name text | 60 / 90 |
| Contact email | 2 | contact email text | 25 / 60 |
| Amount | 1 | amount > 0 | 50 / 85 |
| Margin | 2 | margin > 0 | 50 / 85 |
| Value split | 3 | any split row | 25 / 60 |
| Close date | 3 | set | 60 / 90 |
| Deal type | 1 | set | 30 / 70 |
| Source | 1 | text | 25 / 60 |
| Next step | 2 | text | 30 / 70 |
| Description | 2 | text | 25 / 60 |
| Required custom fields | always | value present | 40 / 75 |

Band: ≥ green → good, ≥ amber → patchy, else poor. Ratio = 1 when nothing applies. Not scored: competitor, probability, owner, currency, name.

#### 6.8.4 Heuristic predictions (Command Center)

Per open deal, values 0–1:

- **Momentum:** start 0.5; activity in last 14 d ≥ 5 → +0.2, ≤ 1 → −0.15; stage change within 7 d → +0.15; last email ≤ 5 d → +0.1, > 21 d → −0.1; overdue tasks ≥ 2 → −0.15. Trend > 0.6 up, < 0.4 down. Confidence 0.3 + 0.25 (any activity 14 d) + 0.15 (any email).
- **Stale risk:** idle = max(days since activity, days since stage change); idle ≥ 30 → +0.5, ≥ 14 → +0.3; stage change ≥ 21 d → +0.2; failed email in 30 d → +0.1. Confidence 0.4 + min(0.3, age/180).
- **Close probability** = clamp(0.6 × legacy probability/100 + 0.3 × momentum + 0.1 × window); window: no date 0.4, past 0.2, > 90 d 0.6, > 30 d 0.85, else 1. Flag `low_probability_high_value` when base < 0.3 and amount ≥ 5,000,000 minor.
- Show only confidence ≥ 0.4; top 12 by severity.

#### 6.8.5 Stage stall

`exceeds-average` when time in the current stage > the workspace average for that stage (closed intervals); otherwise `long-in-stage` when there is no average, the stage is active and time > 30 days.

### 6.9 Forecast (flag `forecastsEnabled`; manager, admin)

| Item | Rule |
|---|---|
| Period | Fiscal quarter (3-month blocks from the FY start month; label "Q{n} {FY start year}") or calendar month ("Mon YYYY"); half-open ranges |
| Deals | `ExpectedCloseDate` in the period, not deleted, optional owner filter |
| Effective category | stored category, else derived from stage |
| Overdue row | stage not won/lost/hold and close date < today — **excluded** from category cells and from Commit/Best case ("Overdue — needs re-forecast") |
| Cell | Σ amount, weighted = round(Σ amount × stage probability / 100), count |
| Commit | commit + closed_won |
| Best case | commit + closed_won + best_case |
| Grand total | all categories + overdue (must reconcile with the board) |
| Overrides | count of deals with a manual category shown |
| Drill-down | each cell links to the deal list filtered by stage, close range and owner (or unassigned) |
| Weekly snapshot | Sunday 19:00 UTC (= Monday 00:30 IST): current fiscal quarter → team rows per category (owner null) + `overdue` row + per-owner × category rows; zero-count cells skipped; drives "vs last week" delta |

### 6.10 Tasks, notes, comments, notifications and activity

#### 6.10.1 Tasks (`CrmTask`)

| Item | Rule |
|---|---|
| Fields | title, description, status (todo default, in_progress, completed, cancelled), priority (low, medium default, high, urgent), type (call, email, meeting, internal, followup; optional), recurrence (daily, weekly, custom), due date, assignee, created by (`system` for automation), completed at, linked entity (deal/company/contact), soft delete |
| Permission | reuses `manageDeals` |
| Visibility | sales persona: tasks assigned to them or unassigned |
| Complete | status completed + `CompletedAt`; notify the creator (`task_completed`, "Task completed: X"); recurring task → create the next instance due +1 day (daily), +7 days (weekly), +1 month (custom — source comment says +30 d; decide) |
| Assignment notifications | create with assignee ≠ actor → "New task: X"; reassign → "Reassigned to you: X"; field update → "Task assigned: X". If linked to a deal/company/contact, also an email |
| Deal rescoring | any task change on a deal queues health recompute |
| Filters | status, priority (multi), assigned to me, unassigned, due within N days (includes overdue), overdue |
| Sort | due date asc (nulls last), created desc, Id desc |
| Summary widget | counts, overdue count, next ~5 items |
| Not enforced | `StageBlocking` exists but is not used by any stage logic (decide: drop or implement) |

#### 6.10.2 Notes, comments

- **Notes:** body, author, entity (deal/company/contact), soft delete; newest first, ≤ 100.
- **Comments:** threaded (parent comment), body, @mentions written as `@[Name](userId)`, edited at, soft delete; oldest first, ≤ 200. Each mentioned user gets `comment_mention` ("Mentioned you in a comment").
- **Task comments:** per task, ≤ 200.
- Typing indicators/presence are realtime extras (§6.19).

#### 6.10.3 Notifications

Types: task_assigned, task_completed, task_due_soon, deal_won, deal_lost, owner_changed, comment_mention, automation_failed. Each row: recipient, actor, type, entity, title, subtitle, metadata, read at. Bulk sends de-duplicate recipients and skip the actor. Notification failures never break the main action. Retention: read > 30 days and unread > 90 days are deleted daily.

> `task_due_soon` and `automation_failed` are defined but never sent in the source — decide whether to implement (recommended: a daily due-soon timer).

#### 6.10.4 Activity log and timeline

- `ActivityLog`: actor (null/System for automation), entity type (company, contact, deal, membership, invitation, task, note, email), entity id, action, metadata (JSON). Actions: created, updated, deleted, restored, stage_changed, invited, invitation_revoked, member_removed, role_changed, automation_note, task_completed, owner_changed, email_sent, email_failed, deal_approved, deal_rejected, call_logged, meeting_logged, gate_warning, email_synced, merged, dedup_override, value_split_changed.
- **Entity timeline** = activity + notes + comments + emails, newest first (`email_synced` activity rows de-duplicated against their email rows).
- **Account timeline** (company) also fans in its deals and contacts (bounded) and tags each row with its source.
- Activity screen (manager/admin): workspace feed.

### 6.11 Sales targets

| Item | Rule |
|---|---|
| Setup | Settings → Sales targets (`manageTargets`): one row per user per fiscal year — revenue target and margin target (0–999,999,999,999, "Cannot be negative"), entered in major units, stored in minor units in the workspace default currency. Owners/admins are not listed. Year picker: current −2 … +1 |
| Fiscal year | `FiscalYear` = starting calendar year. Window = [Y-startMonth-01, (Y+1)-startMonth-01) UTC. Label "2026" when FY starts in January, otherwise "FY2026–27" |
| Quarters | 4 × 3-month windows from FY start. Quarterly target = floor(annual / 4) for Q1–Q3, remainder in Q4. No monthly targets |
| Deals counted | stage won, owner set, not deleted, `ClosedAt` within the FY, approval none/approved (pending/rejected shown as a footnote) |
| Weighted value | `round(AmountMinor × QuotaWeight)` (0.5 when pushed > 3 times) |
| FY attribution | For each split row: `amount × overlapDays(row period, FY) / periodDays` (half-open). Deal with no split → 100 % in its close year (disclosed "N of M won deals have no revenue breakdown — counted in full against this year") |
| Outputs | TCV won = Σ weighted amount; FY revenue = Σ round(inFY × weight); prior; future = max(0, TCV − FY − prior); margin achieved = round(Σ amount × marginBps / 10000) (not weighted, not prorated, null margin = 0); pending and de-weighted disclosures |
| Achievement % | round(FY revenue / revenue target × 100); target ≤ 0 → 100 if anything achieved else 0; bar capped at 100 %; second bar "Margin on TCV won" vs margin target |
| Pace | elapsed = (now − FY start)/(FY length), clamp 0–1; expected = round(target × elapsed); ratio = achieved/expected (1 if expected 0). Bands ≥ 1.05 ahead, ≥ 0.9 on-track, ≥ 0.7 behind, else at-risk. Required per month = gap / months left (months left = days left / (365/12); null if < 0.25) |
| Coverage | gap = max(0, target − achieved); ratio = open pipeline / gap. ≥ 3 healthy, ≥ 2 thin, < 2 at-risk; states no-target, met. "Pipeline needed" = gap × 3 |
| Visibility | sales persona sees only their own row; sort revenue target desc, then FY revenue desc |

### 6.12 Incentives (variable pay)

**Units:** pay in ₹ Lakh (L), revenue in ₹ Crore (Cr); 1 Cr = 100 L. Exact decimal arithmetic, rounded once to 6 dp.

#### 6.12.1 Plan terms (one plan per user per FY; template per workspace)

| Term | Unit | Default | Bulk-editable |
|---|---|---|---|
| Fixed CTC | L | 22 | no |
| Target variable (= 100 % payout) | L | 10 | no |
| Gate revenue | Cr | 5 | yes |
| Gate incentive (paid once gate is crossed) | L | 3 | yes |
| Slab 1 upper | Cr | 10 | yes |
| Slab 1 rate | L per step | 1 | yes |
| Slab 2 rate (accelerator above slab 1) | L per step | 2 | yes |
| Step | Cr | 1 | yes |
| Accrual basis | pro_rata / full_step_only | pro_rata | yes |
| Cap enabled / cap amount | bool / L | false / null | yes |
| Prior-year credit % | fraction | 0.25 | yes |
| Net-new credit % | fraction | 1 | yes |
| Margin floor % | fraction | 0.20 | yes |
| Margin-miss treatment | pro_rata / nil / ignore | pro_rata | yes |

Validation: all required and ≥ 0; step > 0; slab 1 upper ≥ gate; each credit weight ≤ 5 (500 %); margin floor ≤ 1; cap amount required when cap on. Actuals ≥ 0, margin ≤ 1. Invalid input → refuse to calculate (never show ₹0).

#### 6.12.2 Calculation (forward)

```
credited     = prior × priorYearCreditPct + netNew × netNewCreditPct
gateMet      = credited ≥ gate
accrue(x)    = full_step_only ? floor(x / step) × step : x
slab1Span    = gateMet ? accrue(max(0, min(credited, slab1Upper) − gate)) : 0
slab2Span    = gateMet ? accrue(max(0, credited − slab1Upper)) : 0
gross        = (gateMet ? gateIncentive : 0) + slab1Span/step × slab1Rate + slab2Span/step × slab2Rate
afterCap     = capEnabled ? min(gross, cap) : gross
marginMult   = ignore → 1 ; margin ≥ floor → 1 ; nil → 0 ; pro_rata → margin / floor
finalPayoutL = afterCap × marginMult
payoutPct    = finalPayout / targetVariable
totalCash    = fixedCTC + finalPayout ;  variableShare = finalPayout / totalCash
totalRevCr   = prior + netNew ; marginContribution = totalRev × margin
incentive % of margin  = (finalPayout / 100) / marginContribution
incentive % of revenue = (finalPayout / 100) / totalRev
Flags: belowGate = !gateMet ; marginMiss = treatment ≠ ignore AND margin < floor ; breach = payoutPct > 1
capApplied = capEnabled AND gross > cap ; gateShortfall = max(0, gate − credited)
```

**Reverse ("revenue needed for 100 %")**: cap below target → unreachable (`cap_below_target`); target ≤ gate incentive → the gate; else slab1Max = (slab1Upper − gate)/step × slab1Rate (step count floored under full_step_only); if remaining target fits in slab 1 → gate + steps × step; else if slab2Rate = 0 → unreachable (`no_rate_above_gate`); else slab1Upper + ((rem − slab1Max)/slab2Rate) × step (steps rounded up only under full_step_only). Helpers: what it takes (net-new needed = credited gap / netNewCreditPct), next step (zone + payout of one more step), ladder (gate … slab1Upper + 5 steps, ≤ 60 rows), what-if slider (0.1 Cr steps).

**Parity test cases** (workbook defaults):

| Case | Input | Expected |
|---|---|---|
| WB1 | prior 8, net-new 6, margin 0.20 | credited 8; payout **6 L** (60 %); total cash 28; variable share 0.214286; incentive % margin 0.021429; % revenue 0.004286 |
| WB2 | as WB1, margin 0.18, pro_rata | **5.4 L** |
| WB3 | as WB1, margin 0.18, nil | **0** |
| WB4 | prior 8, net-new 10 | credited 12; **12 L** (120 %, breach) |
| WB5 | reverse, defaults | **11 Cr** credited |
| Capped | gate 6 / 4 L, slab1 12 @ 1.5, slab2 @ 3, cap 18; prior 10, net-new 14 | gross 26.5 → **18** |
| Full step | gate 4 / 2 L, slab1 8; prior 4, net-new 8.4 | **8** |

#### 6.12.3 Plan lifecycle and actions (`manageIncentives` unless stated)

| Action | Rule |
|---|---|
| Save template | terms + optional budget (≥ 0); never changes existing plans |
| Create plan | user + FY (2000–2100) + terms; status draft; version 1; unique per (user, FY) → conflict; version row `created` |
| Update plan | **one kind of change per call** (terms, status, or actuals source) + optional note ≤ 500; optimistic lock with expected version ("stale" conflict); version + 1; version row `updated` / `status_changed` / `actuals_source_changed` with field diff and full snapshot |
| Status | draft / active / closed — UI: Activate (if not active), Close (if active), Move to draft (if not draft); closed plans refuse manual actuals |
| Manual actuals | plan's own user or admin; refused when source = computed or plan closed; always appended (as-of date, prior Cr, net-new Cr, blended margin) |
| Computed actuals | nightly 01:40 UTC + "Recompute now" — active plans with source computed; one row per plan per day (upsert) |
| Bulk change | choose FY + plan statuses (default active) + changed bulk-editable terms → **preview** (current vs new payout) → **apply** refused if any plan changed since preview ("Plans changed since the preview…") or would become invalid; all-or-nothing; version action `bulk_updated` |
| What-if API | `GET /plans/{id}?prior=&netNew=&margin=` computes without saving |

**Computed actuals rules:** won deals owned by the plan user, not deleted, approval none/approved, × QuotaWeight. FY portion: value split prorated by date overlap, else full amount if closed in the FY. Prior-year = closed before FY start (carry-forward from splits); net-new = closed inside the FY; closing after FY end excluded. Blended margin = Σ(inFY × marginBps/10000) / Σ inFY over deals with margin, clamp 0–1. Cr = paise / 1,000,000,000. Disclose exclusions: no close date, non-INR, no margin (revenue still counts), no split (single-year assumption), pending approval.

**Visibility:** own plan, or anyone's with `viewTeamIncentives`; a user can't see their own **draft** unless owner/admin/manager; My Incentive shows non-draft only. Roll-up (manager/admin, non-draft): projected payout, target variable, counts below gate / margin miss / breach / missing actuals, budget and remaining. Plans without actuals show "no result", never ₹0.

### 6.13 Proforma invoices (PI)

#### 6.13.1 Data and rules

| Item | Rule |
|---|---|
| Header | PI number, PI date, status (stored draft; "sent" never set), currency **INR (fixed)**, seller / buyer / consignee **snapshots** (later company changes never alter a PI), payment terms, delivery terms, notes ≤ 1000, GST % (default **18**), shipping amount + shipping GST %, linked deal (optional) + credit-days override |
| Party fields | name 1–200; address ≤ 600 (required for buyer/consignee); city, locality, pincode; GSTIN ≤ 20; state code `NN` (required for buyer/consignee — "Select a state") |
| Seller | from the selected **seller profile** (one per Indian state code: name ≤ 200, address ≤ 600, GSTIN ≤ 20 and must start with the state code — "GSTIN for X must start with NN", PAN ≤ 15, CIN ≤ 30 optional, bank name ≤ 120, account ≤ 40, IFSC ≤ 20, branch ≤ 120). Create is blocked if no profile exists. Seller block read-only on the form |
| Items | 1–100 lines: description 1–300, HSN/SAC ≤ 20, unit 1–10 (default "No"), quantity integer 1–1,000,000, rate 0–1e9 (₹), optional image (jpeg/png/webp ≤ 6 MB, compressed client-side to max 1280 px, quality 0.7) |
| Who | **create:** any active member (*decide:* exclude viewer); **list:** members see own, owner/admin/manager see all; **edit/delete/PDF:** creator, owner, admin (*fix:* managers who record payments should also open the PDF); **delete** refused if any payment exists |

#### 6.13.2 Numbering

`PI/{YY-YY}/{NNN}`, e.g. `PI/25-26/001`. FY is **Indian April–March, hard-coded** (not the workspace FY setting): month ≥ 4 → start = year, else year − 1. Sequence = max existing number in that FY (by PI date) + 1, zero-padded to 3 (grows to 4+ digits after 999; deleted numbers are never reused). On a unique-number clash retry up to 6 times. Editing keeps the original number even if the date moves to another FY.

#### 6.13.3 Totals and GST

```
amount_i     = round(qty_i × round(rate_i × 100))            (paise)
subtotal     = Σ amount_i
itemsTax     = round(subtotal × GST% / 100)                   (one rate per invoice)
shipping     = round(shippingAmount × 100)
shippingTax  = round(shipping × shippingGST% / 100)
tax          = itemsTax + shippingTax
total        = subtotal + shipping + tax
```

- Party state code = explicit state code, else first two digits of GSTIN.
- Place of supply = consignee state, else buyer state.
- **Inter-state** (seller code and place code both known and different) → **IGST** at the full rate.
- **Otherwise intra-state** → CGST = round(tax / 2), SGST = tax − CGST, each at half the rate (split goods and freight separately on the PDF).
- Worked example: items 2 × ₹1,000 + 1 × ₹500.50 → subtotal 250,050 p; GST 18 % → 45,009; shipping ₹100 @ 5 % → 10,000 + 500; tax 45,509; **total 305,559 p (₹3,055.59)**; intra-state goods CGST 22,505 + SGST 22,504, freight 250 + 250.

#### 6.13.4 PDF layout (A4, rebuild server-side)

- Title "Proforma Invoice" (bold 13 pt, centred). Header box split at 56 %.
- **Left:** logo (fit 24 × 14 mm; from invoice settings, current logo at print time), seller name (bold), address, `GSTIN/UIN : …`, `State Name : X, Code : NN`, `CIN : …`; then **Consignee (Ship to)** (falls back to buyer) and **Buyer (Bill to)** with name, address, GSTIN, state.
- **Right:** Proforma Invoice No., Dated (`DD-Mon-YY`), Mode/Terms of Payment, Terms of Delivery.
- **Items grid:** Sl | Description of Goods/Services | HSN/SAC | Qty | Rate | per | Amount; footer rows Total (subtotal), Freight / Shipping (if > 0), "Output GST @ X%" (or "Output GST" when shipping is charged), grand Total with total quantity + first item unit.
- **Amount Chargeable (in words):** "INR … [and NN Paise] Only" in the Indian system (Crore/Lakh/Thousand/Hundred).
- **Tax summary:** inter-state → HSN/SAC | Taxable Value | IGST Rate/Amount | Total Tax; intra-state → HSN/SAC | Taxable Value | Central Tax Rate/Amount | State Tax Rate/Amount | Total Tax; one goods row (joined HSN codes or "Goods") + a Freight row if shipping.
- **Bottom box (52 % split):** left — Tax Amount (in words), Company's PAN, Declaration (fixed e-invoice exemption text from `src/lib/invoices/pdf.ts:18-23`); right — Company's Bank Details (A/c holder = seller name, bank, A/c no., Branch & IFSC), "For {seller}", "Authorised Signatory".
- Footer "This is a Computer Generated Invoice". File name = PI number with `/` → `-` + `.pdf`.
- *Fix:* print the State line from the selected state code, not only from the GSTIN.

#### 6.13.5 Invoice settings (owner only)

Workspace payment and delivery terms (≤ 300 each, prefilled on new PIs), seller profiles per state (upsert/delete), invoice logo (png/jpeg/webp ≤ 2 MB; upload/remove).

### 6.14 Collections

| Item | Rule |
|---|---|
| Settings | standard credit days (30), material excess days (15) |
| Deal credit terms | `manageDeals` sets agreed days (0–730) + note ≤ 500 on a deal; **over standard needs approval** by `approveCreditTerms` (owner/admin/manager). If the setter has that permission the terms are self-approved. Changing the days clears an earlier approval; saving the same days keeps it; at or below standard → no approval stored. "Needs approval" is re-evaluated at read time against the current standard |
| Effective terms | no row → standard, flagged *assumed* (never compliant); over standard + approved → approved; over standard + not approved → unapproved override |
| Invoice ↔ deal | creator/owner/admin link a PI to a deal (not deleted; picker shows non-lost deals, newest 300; members see own deals) and optionally override credit days |
| Payments | `recordPayments` (owner/admin/manager): amount > 0 ≤ 999,999,999,999, paid-on date not in the future, reference ≤ 120, note ≤ 500; delete payment. *Add:* overpayment guard and paid-on ≥ PI date (missing in source) |
| Per-invoice status | creditDays = PI override ?? deal agreed ?? standard; due = PI date + creditDays; fully paid on = first date the running payment sum ≥ total; outstanding = max(0, total − paid); state paid / partial / unpaid; overdue = not paid and today > due; days to collect; collected on time = fully paid ≤ due. Badge: Paid / Overdue / Partly paid / Unpaid. **No aging buckets** in the source |

**Report "Credit period vs achievement"** (manager/admin, `viewCollections`):

- Period FY or Q1–Q4 (workspace FY); target share = annual or quarter split.
- Booked deals: won, not deleted, owner set, approval none/approved, closed in period (**face value, no quota weight** — differs from Targets; decide).
- Per SPOC (deal owner): booked amount and count; amount-weighted average agreed credit days (1 dp); assumed and unapproved-override counts; invoiced (PIs dated in period, attributed to the linked deal's owner); amount-weighted average days to collect over fully paid invoices; collected/partial/unpaid counts and outstanding; on-time collected % (by value); achievement % = booked / period target.
- **Flag:** median of achievement over SPOCs with a target. Above median → `funding_customers` if avg credit > standard + material excess, `outperforming` if ≤ standard, else `standard`; below median → `underperforming`; no figure → `standard`.
- Sort: avg credit days desc, then booked desc.
- Company summary: booked, invoiced, collected (payments dated in period), booked − collected ("Booked but not yet collected"), invoiced − collected, unattributed invoices (count/value), assumed and override counts.
- Drill-down per SPOC: over-standard deals with collection status not_invoiced / overdue / outstanding / on_time / late.
- No FX conversion.

### 6.15 Communications and outbound email

| Item | Rule |
|---|---|
| Inbox (manager/admin — hidden from members because it is workspace-wide) | Folders Inbox, Sent, Drafts, Failed (badge), Archived; thread list ordered by last message; counters message/unread/failed per thread; thread status active / archived / muted / spam |
| Threading | Subject normalised by removing leading Re:/Fwd:/FW: repeatedly, collapsing spaces, lower-casing. A message joins a thread only if normalised subject matches **and** participants overlap |
| Compose / reply / forward | Drafts autosave (debounced), versioned, one per (user, context kind, thread, entity); server copy wins on conflict |
| Send — `Email_Send` | Subject ≤ 998, body ≤ 50,000, ≤ 50 each of to/cc/bcc, idempotency key 8–120 chars (duplicate key → no second send). Permission by linked entity (manageDeals / manageCompanies / manageContacts). Flow: insert `queued` → atomic `queued → sending` (prevents double send) → provider → `sent` or `failed` (+ retry count). Activity `email_sent` / `email_failed`; attach to thread; communication event; relationship signal bump; agent observation |
| Retry | ≤ 3 attempts; refused for rows already sent or sending. Error classes: permanent (auth, bad address) vs retryable (SMTP 421/450/451/452, connection; unknown = retryable) |
| Sender | Workspace sender name/email/reply-to/auto-BCC/signature from Settings → Email; deployment-level provider: SMTP (nodemailer) or Resend (idempotency header, retry on 5xx/429) or console (dev) |
| Automated emails | Never fail the main action. Triggers: task assigned (when linked to an entity), deal owner changed ("You've been assigned: {name}"), invitation, password reset. Content is built in code (no template table) — *recommended:* move to an `EmailTemplate` entity |
| Relationship signals | Per entity: last inbound/outbound, totals, unanswered count, avg response hours, silent days. **Score** = 0.4 × min(1, inbound/10) + 0.3 × min(1, inbound/(outbound + unanswered)) + 0.3 × max(0, 1 − silentDays/30). Status ≥ 0.7 healthy, ≥ 0.5 warming, ≥ 0.3 stale, else at_risk. Recomputed nightly (04:00 UTC) |
| Analytics | Nightly (02:00 UTC) counts of today's events by kind → `CommunicationAnalytic`; success rate = sent / (sent + failed + retried); bounce rate = bounced / sent |

### 6.16 Gmail sync (flag `emailSyncEnabled`)

- **OAuth** scope `gmail.readonly` only; offline access + consent prompt. State parameter HMAC-signed over {tenant, user, expiry}, valid 10 min, verified against the live session. Callback errors: access_denied, not_configured, invalid_state, no_refresh_token, exchange_failed. Refresh token stored **encrypted (AES-256-GCM)**. Google restricted-scope verification (CASA) is required for external production use.
- **Sync every 10 minutes** per active connection: fresh access token; incremental `history.list` from the stored history id, fallback (first run or 404) `newer_than:7d` (≤ 200); ≤ 100 messages per run; **metadata only** — From/To/Cc/Subject and a ≤ 200-char snippet; bodies and attachments never stored. Success → advance history id, status active; error → status error + last error (≤ 500).
- **Linking:**
  1. Counterparties = from/to/cc minus the mailbox owner, excluded addresses and domains. None → skip.
  2. Match contacts by email (case-insensitive). **No match → write nothing.**
  3. Open deals of those contacts by updated desc: 0 → attach to the contact; 1 → that deal; > 1 → most recent deal + `needsReview`.
  4. Insert email (provider gmail, status delivered, direction by From); idempotent on (tenant, provider message id).
  5. Activity `email_synced`; attach/create thread; event received/sent; relationship signal (inbound reduces unanswered, floor 0); health recompute for the deal.
- Synced emails count as genuine activity for stage gates and health score.

### 6.17 Dashboards and reports

#### 6.17.1 Shared filters

- Dashboard range: last_7d, last_30d, last_90d (default), this_quarter, this_year, custom; "prior" = preceding window of equal length.
- View scope: team (default) or a single rep.
- Report presets: today, last_7d, last_30d, last_90d, this_quarter, this_year, all_time (from 2000-01-01); UTC half-open.
- **Delta rules:** prior = 0 → "New this period"; |%| > 500 → show absolute change; |%| < 0.05 → flat; rates compared in percentage points; each tile knows whether higher is better.

#### 6.17.2 Home dashboard KPIs (persona-specific layouts)

| KPI | Formula |
|---|---|
| Total pipeline (stock at time T) | Σ amount of deals created ≤ T, not closed by T, stage at T (from stage history) not won/lost; current = now, prior = range start |
| Weighted pipeline | Σ round(amount × stage probability / 100) |
| Win rate | won / (won + lost) for deals closed in the window |
| Avg won deal size | Σ won amount / won count |
| Avg sales cycle | avg days (closed − created) for won deals, 1 dp |
| Won / lost counts | in window |
| Quota attainment | FY-to-date Σ round(amount × quota weight) for won deals with approval none/approved; also pending amount/count and de-weighted loss; tile hidden if Σ target = 0 |
| Coverage | §6.11 |

- **Highlights** (5 each, "View all"): big wins (won in window by amount), progressed (stage moves in window), new deals, at risk (open, no touch for 14 days across updates/activity/notes), closing soon (close date within 14 days).
- **Attention queue** (Executive, top 6): score = 0.35 × stalled + 0.30 × value + 0.20 × regressed + 0.15 × unset; stalled = min(1, days since activity / 120) (none = 120); value = ln(1 + amount)/ln(1 + max amount); regressed = 1 − days since backward move / 90 (0 if never); unset = 0.5 (no next step) + 0.5 (no close date). Reason line from the biggest factor (tie order regressed > value > stalled > unset), e.g. "High value, no activity 91d".
- Persona layouts — **admin**: KPI strip, AI calls/tokens (24 h), risk flags, recommendations, record counts, workflow health; **manager**: team pipeline, weighted forecast, team revenue (90 d), conversion, avg cycle, active reps, at risk, stalled, inbox counts; **sales**: my pipeline by stage, my revenue trend, my deal counts, my tasks.

#### 6.17.3 Standard reports (all with CSV export)

| Report | Range | Owner filter | Logic |
|---|---|---|---|
| Pipeline by stage | live | yes | count + Σ amount per stage, all stages incl. zero |
| Funnel by offering (flag) | live | yes | a deal counts in full in **each** offering it carries (overlap count disclosed); offering filter beats category filter |
| Win/loss rate | default 90 d, on close date | yes | win rate, total closed, total revenue |
| Stale deals | live | yes | active stages; signals: no activity 30 d, no email 14 d, no stage move 21 d; severity by signals fired 0 ok, 1 watch, 2 stale, 3 critical; new deals fire only when older than the threshold; ≤ 200 rows |
| Rep performance | default 90 d | no | per owner: won count/revenue/avg, lost, activities, emails, tasks completed, win rate; sorted by revenue |
| Email engagement | default 30 d | no | counts by status; success = (sent + delivered)/total; retry rate = Σ retries / total |
| Revenue forecast | forward, default next 180 d (presets 30, 90, quarter = 92, year = 365) | no | open deals by close month: likely = Σ amount × prob; best = Σ amount; worst = Σ amount × prob where prob ≥ 50; confidence = min(1, likely/best). *Fix:* use the workspace stage probabilities (source hard-codes 10/25/50/75) |
| Deal velocity | default 90 d | yes | from `stage_changed` activity: avg/median/max days per stage, avg days to close, bottleneck (highest avg), fastest (lowest avg with ≥ 3 samples), stalled = open deals older than the stage's P75, stalled rate |

#### 6.17.4 Other analytics screens

- **Executive** (manager/admin): revenue (won all-time, likely, best case, win rate), weekly revenue trend, pipeline health, top performers, velocity & bottlenecks, operational health (emails sent, retry rate, stalled, active deals), attention queue, AI daily brief and recommendations.
- **Command Center** (admin): predictions (§6.8.4), AI risk flags and recommendations, inbox counts, pipeline by stage, 24-hour intelligence timeline (activity + AI + communication events + relationship signals).
- **My Performance** (self): revenue, win rate, won/lost, avg cycle, activity, team rank, my pipeline, tasks, AI coaching hint.
- **Team Performance** (manager/admin) — one row per rep, FY-to-date: revenue target, FY revenue, TCV won, won count, pending approval, de-weighted loss, no-split count, Q1–Q4 (target annual/4), pace, coverage; **pushback** (push count, distinct deals, days added, pushes by others, open value pushed, half-weighted deals, most-moved deal, "recorded since" date); **engagement** (deals created per week, best week, open deals, stale open deals (14 d), days since last touch/activity; band ≤ 2 d active, < 7 d quiet, else silent); **completeness** (§6.8.3). **Trends "vs last month"** from monthly snapshots (raw counters: FY revenue, target, push events, days pushed, deals created, open deals, stale open deals, completeness filled/applicable); cumulative metrics compared within the same FY only; a missed month falls back to the latest available.
- **Chart Studio:** saved per-user chart views (one default per chart). Charts: revenue trend (weekly default; area, flutter, stacked area, line, bar; metrics revenue, deal count, avg size, conversion; toggles legend, smooth, animate, show lost, compact, cumulative), stage conversion (bars/funnel), stage donut (donut/pie/bars). Dashboard widgets with grid layout (default 4 × 4).
- **Operations** (admin): AI usage, automation health, email provider (masked credentials), delivery stats, errors, latency, logs, realtime, workflows. (In-process metrics in the source — use OutSystems Service Center / monitoring and the `AiInvocation`/`WorkflowRun` entities.)
- **Workflows** (admin): job runs with status running/completed/failed/skipped.

### 6.18 AI and intelligence

| Item | Rule |
|---|---|
| Providers | OpenAI: chat and summaries `gpt-4o-mini`, embeddings `text-embedding-3-small` (1536-d). Anthropic: risk explanations only (model from configuration) |
| Modes | live (enabled + key), mock (disabled → deterministic stubs, full pipeline still works), disabled (enabled but no key). A separate switch gates customer-facing deal AI cards (default off) |
| Budget | per-workspace 24-hour token ceiling (default **200,000**) from `AiInvocation`; each regeneration pre-checks ~1,000 tokens; over budget → skip gracefully ("budget" state) |
| Audit | every call logged: kind (embed, chat, search, summary), model, tokens, latency, status (success, error, skipped) |
| Insight cache | types: daily-exec (per UTC day), deal-summary, risk-flag-set, recommendation-set, pipeline-summary, activity-summary, thread-summary; keyed by a hash of the deterministic source data + prompt version; states cached / stale / generating / failed / mock / budget / disabled. **Reads never wait for the model:** return the cached/stale value and regenerate in the background (OutSystems: queue + timer or async light process) |
| Prompts (JSON out, temperature 0.2, ≤ 600 tokens) | daily exec (headline, 3–6 bullets, optional callout info/warning/danger); deal summary (narrative, ≤ 3 risks, ≤ 3 next actions, confidence); risk flags (≤ 6; candidates = active deals with no activity 14 d or no email 9 d, top 12 by amount; signal codes no_recent_activity, no_recent_email, no_stage_movement, overdue_followup, low_probability_high_value, inactive_owner, workflow_failure, email_delivery_failure, stalled_at_stage; hide confidence < 0.4); recommendations (≤ 5, sorted by amount × likelihood; action kinds send_email, create_task (needs due-in-days), reassign_owner, update_stage, add_note); pipeline summary; thread summary (narrative, unresolved, next actions, risk notes, sentiment, confidence). Copy the prompt texts from `src/lib/intelligence/prompts.ts` |
| Entity summary | 2–4 sentence summary, temperature 0.2, ≤ 220 tokens, cached by source hash |
| Copilot chat | question ≤ 2000, history ≤ 12 turns; retrieval (semantic search over deals/companies/contacts, cosine distance ≤ 1.4, top 6) → system prompt "only use retrieved CRM context…" → streamed answer (temperature 0.3) with references |
| Embeddings | text per entity: name, stage, amount, dates, company, contact, last 8 activity lines; skip re-embedding when the content hash is unchanged; queued on create/update/restore |
| Feedback | 👍/👎 on insights (helpful, not_helpful, dismissed — one per user per insight); recommendation verdicts accepted / ignored / dismissed / completed (+ agent observation) |
| Learning loop | observations (deal.created/stage_changed/won/lost/reassigned, task.created/completed/overdue, email.sent/failed, recommendation.*), outcome scores won +1, lost −1, email sent +0.1, failed −0.2; pattern `followup_timing`: win rate by hours to first follow-up (0–24, 24–72, 72–168) vs baseline over 90 days, Wilson confidence, min sample 8, noise floor 0.4; boost = score × (1 + clamp(Σ delta × confidence, ±0.35)) — explains "Why am I seeing this?". *The deriver is never scheduled in the source — decide: schedule nightly or drop.* |

### 6.19 Search and realtime

- **Global search (Cmd+K):** one request, 5 parallel "contains" searches, ≤ 5 hits each — deals (name), companies (name or domain), contacts (first, last, email), workflow runs (id), tasks (title). Respect tenant, soft delete and sales scope. Each hit: kind, title, subtitle, link, plus stage/status/priority.
- **Realtime (source):** Postgres NOTIFY → SSE stream, 25 s keep-alive, reconnect every 4 min, replay of last 200 events per tenant, presence ("X is viewing"), typing indicators, cross-tab draft sync. Default **off** in the source (cost guard); data refreshes on navigation.
- **OutSystems recommendation:** phase 1 — refresh on navigation + 30 s polling on board, inbox and notifications from a `RealtimeEvent` entity (TenantId, Type, EntityType, EntityId, CreatedAt; purge after 1 day). Phase 2 — WebSocket component for presence/typing if required.
- Event names to keep: deal.created/updated/stage_changed/deleted/restored, company.*, contact.*, member.invited/invitation_revoked/removed/role_changed, activity.recorded, notification.created, comment.created, ai.summary.updated, intelligence.risk.updated, intelligence.recommendation.updated, communication.thread.updated, communication.message.sent/failed, communication.draft.updated.

### 6.20 Ask Mira integration

See §8.2 (it is an API for an external system).

### 6.21 Soft delete, recently deleted, workspace deletion

- Soft delete: companies, contacts, deals (owner/admin), tasks, notes, comments. Sets deleted at/by; "… not found or already deleted." if already deleted; activity `deleted`.
- **Recently deleted** (admin persona): deleted companies, contacts, deals, newest first, 50 per type; text "Owners and admins can restore. Permanent delete is owner-only."
- Restore (owner/admin) → clears deleted fields, activity `restored`.
- Permanent delete (owner) → two-step confirm ("Permanent — cannot be undone." → "Delete forever"); removes the row and children. *Add:* require the record to be soft-deleted first and write an audit entry (source does neither).
- **No automatic purge** of soft-deleted CRM records.
- Other behaviours: offerings retire-only, custom fields archive-only, stage-gate rules hard delete, invitations hard delete on revoke, member removal deletes the membership only, workspace delete cascades everything (§6.3).

---

## 7. Background jobs → OutSystems timers

All source jobs are Inngest functions (there are **no** Vercel crons). Every run is tracked in `WorkflowRun` (running → completed / failed / skipped). Cron jobs loop over all tenants and process each tenant in isolation (one tenant failing must not stop the others). In OutSystems: one Timer per job in `Salenix_Jobs`, each iterating tenants with a per-tenant try/catch and a `WorkflowRun` row, and committing per tenant (`CommitTransaction`) to stay within timer timeouts.

### 7.1 Scheduled jobs (times in UTC)

| Timer | Schedule | Logic | Flag |
|---|---|---|---|
| `Timer_DealScoresNightly` | daily 01:00 | Recompute health score for all open deals | dealScoringEnabled |
| `Timer_DealRiskNightly` | daily 01:30 | Score every open (not won/lost/hold) deal, prune others, AI-explain ≤ 25 per tenant whose signals changed | — |
| `Timer_IncentiveActualsNightly` | daily 01:40 | Active plans with computed actuals → upsert today's actuals row | — |
| `Timer_CommAnalyticsRollup` | daily 02:00 | Count today's communication events by kind; success and bounce rates | — |
| `Timer_RelationshipSignals` | daily 04:00 | Recompute silent days, score, status; write only on change | — |
| `Timer_HoldRevisit` | daily 08:00 | Held deals with revisit date ≤ today and no open task titled "Revisit held deal…": create task "Revisit held deal: {name}" (todo, high, due = revisit date, assigned to owner, created by system, description names the hold reason), activity `automation_note`, notify `task_assigned` | — |
| `Timer_StaleDealsScan` | daily 09:00 | Open deals (not won/lost/hold) not updated for **14** days → activity "Deal X hasn't moved in N days — nudge the owner." | — |
| `Timer_WorkflowRunsRetention` | daily 09:15 | Delete skipped > 7 d, completed > 30 d, failed > 90 d, running > 1 d (orphans) | — |
| `Timer_NotificationsRetention` | daily 09:45 | Delete read > 30 d, unread > 90 d | — |
| `Timer_GmailSync` | every 10 min | §6.16 for each active connection | emailSyncEnabled |
| `Timer_ForecastSnapshotWeekly` | Sunday 19:00 (Mon 00:30 IST) | Capture the current fiscal quarter rollup | forecastsEnabled |
| `Timer_TeamMetricsMonthly` | 1st of month 00:20 | Capture the just-ended month's team scorecard counters (FY taken from day 15 of that month); upsert | — |
| *(new)* `Timer_ProcessQueue` | every 1–5 min | Process `DealRecomputeQueue` (5-min debounce), `EmbeddingQueue`, `InsightRegenQueue`, `ScheduledAction` (e.g. deal-won 7-day follow-up) | — |
| *(decide)* `Timer_AgentPatterns` | nightly | Pattern deriver — exists in source code but is never scheduled | — |

### 7.2 Event-driven workflows

| Source event | Workflow | OutSystems |
|---|---|---|
| Stage changed to **won** (from ≠ won) | (1) activity `automation_note` "Deal "{name}" was marked won. Schedule the kickoff and capture the win." (2) Task "Onboarding kickoff for {name}" — todo, high, **due today + 3 days**, assigned to owner, created by system, linked to deal; activity `created`; notify `task_assigned` ("Due {date}"). (3) After **7 days**: activity "Follow-up reminder… one week after closing." | Call `Workflow_DealWon` after the stage-change commit; step 3 via `ScheduledAction(RunAfter = now + 7 d)` |
| Stage changed to **lost** (from ≠ lost) | Activity "Deal "{name}" was marked lost (from {from}). Capture the loss reason — pricing, timing, competitor, fit — while it's fresh." | `Workflow_DealLost` |
| Health recompute requested | Recompute score, **debounced 5 min per deal** | Upsert `DealRecomputeQueue(DealId, DueAt = now + 5 min)` |
| Embed entity (create/update/restore/manual) | Rebuild source text, skip if hash unchanged, else embed and upsert; delete if entity gone | `EmbeddingQueue` |
| Member invited | Activity "Onboarding queued for {email} ({role})…" | Inline after invite |
| `deal.created`, `company.created`, `contact.created` | Emitted, no subscriber in source | Not needed |

Retries: source retries won ×3, lost ×2, embeddings ×3, recompute ×2. Implement as `Attempts` + `LastError` on the queue rows, max as listed.

---

## 8. Integrations

### 8.1 Outbound integrations

| Integration | Purpose | OutSystems module | Configuration (site properties / secrets) |
|---|---|---|---|
| OpenAI | chat, summaries, embeddings | `OpenAI_IS` (Consume REST) | API key, models, AI enabled flag, daily token limit |
| Anthropic | risk explanations | `Anthropic_IS` | API key, model |
| Email | outbound mail | `EmailSend_IS` (SMTP or Resend REST) | provider, SMTP host/port/user/password/secure, Resend key, From address |
| Gmail | read-only mailbox sync | `Gmail_IS` (OAuth 2.0 + REST) | client id/secret, redirect URI, token encryption key |
| File storage | deal documents, invoice logo, item images | `FileStorage_IS` or binary entities | bucket names (`deal-documents`, invoice bucket), credentials |
| Vector search (optional) | semantic search | `VectorSearch_IS` | see database doc §10.1 |

### 8.2 Ask Mira (exposed API — HRMS ↔ CRM, product id `saleinx`)

**Security model**

- HS256 JWT; issuer `askmira`, audience `askmira:saleinx`, 10 s clock leeway; claim `use` must match the endpoint: provision, query, act, revoke, launch.
- Per-workspace secret = HMAC-SHA256(server key, `askmira-saleinx:v1:{tenantId}:{nonce}`); server key ≥ 32 chars; only the nonce is stored (`AskMiraLink`). The secret is selected by the token's `sub` (tenant) — unknown workspace → 404.
- Server-to-server tokens carry `bh` = SHA-256 of the exact request body; `body.tenant_id` must equal `sub`.
- `act` and `launch` tokens are **single-use** by `jti` (`AskMiraUsedToken`; purge 5 min after expiry).
- Allowed origins from configuration.

**Connect flow (PKCE)**

1. Ask Mira sends its admin to `/connect/askmira` (workspace, return URL, state, PKCE challenge); origin checked.
2. An owner/admin clicks **Allow** → one-time code (5 min).
3. Ask Mira's server swaps code + verifier (S256) at `/connect/token` → `{product, brand, secret, external_ref, organization}`.
4. Links are 1:1 — 409 if either side is already linked elsewhere.

**Endpoints** (expose as REST in `Salenix_AskMira_API`)

| Method / path | `use` | Purpose |
|---|---|---|
| GET / DELETE `/connection` | (signed-in admin) | Read / disconnect |
| POST `/connect/approve` | (signed-in admin) | Issue code |
| POST `/connect/token` | — (PKCE) | Code swap |
| POST `/connect/revoke` | revoke | Ask Mira disconnects |
| POST `/users/sync` | provision | Link active members whose email is in Ask Mira's roster (returns roles); **suspend** linked members missing from the roster (never owners); un-suspend members who reappear; never creates users or changes roles; empty roster → 422 |
| POST `/query` | query | `{tenant_id, kind, actor:{email}, params}`; kinds: **deals** (query on name/company/"Company - Deal", stage(s), mine, awaiting_approval, limit default 25 max 50), **deal** (id), **approvals** (won + pending; needs approveDeals; ≤ 50), **overview** (by stage and currency), **options** (stages, hold/rollback reasons, offerings, rule flags). Sales scope applies. Every response includes `actor` {role, persona, can_manage_deals, can_approve_deals, sees} |
| POST `/act` | act (single-use) | **lead.save** (create/find company, contact, deal at Lead, follow-up task, note — or update), **deal.stage** (stage, margin %, close date, hold fields, lost reason, rollback reason/note, next step), **deal.decide** (approve/reject; manager+), **deal.note**. Each runs the same CRM server actions **as the person** |
| POST `/launch` | launch (single-use) | SSO: `/sso/askmira#token=…` page posts the token; on success links the person, creates the session for that workspace and redirects to a safe relative path (default `/dashboard`) |

Actor rules: actor must be an active member (by email) and not suspended via Ask Mira; roles are always Salenix's own.

**OutSystems notes:** JWT validation and HMAC need a crypto library (Forge JWT component or a small extension); store the server key as a secret site property; build the "as the person" execution by passing the resolved user/tenant into the Core Service actions (they must not depend on the browser session).

---

## 9. Non-functional requirements

| Area | Requirement |
|---|---|
| Tenant isolation | No query may return another workspace's rows. Automated test with two tenants on every Core Service read action |
| Security | Tokens stored as SHA-256 hashes (invites, resets, connect codes); OAuth tokens encrypted at rest; secrets in site properties/secret store; HTTPS only; CSRF protection on exposed endpoints; never log email bodies |
| Auditability | Deal audit log and incentive plan versions are append-only; merge audit keeps loser snapshots; activity log on every user action |
| Performance | Lists paginated (deals board 50 per column; lists 50 per page); exports ≤ 10,000 rows; dashboards built from indexed aggregates; heavy rollups (companies, team performance) may be cached/denormalised |
| Data volume (reference from source limits) | CSV import ≤ 1,000 rows / 2 MB; documents ≤ 15 MB; invoice items ≤ 100; value split ≤ 12 × 10 |
| Localisation | Currency formats per locale (en-IN Lakh/Crore grouping), compact numbers, workspace timezone; Indian number-to-words for invoices |
| Availability of AI | Every AI feature degrades gracefully (mock / budget / disabled states); no screen blocks on an AI call |
| Email | Idempotent sends; no double send; retries ≤ 3; failures visible in the Failed folder |
| Jobs | Idempotent and per-tenant isolated; run history kept per retention rules |
| Accessibility & UX | Light/dark themes, density, reduced motion; mobile drawer navigation |
| Region | Source deploys in Mumbai (`bom1`) — keep data residency in India |

---

## 10. Known gaps in the source and decisions needed

These were found while extracting the rules. Each needs a decision; the recommended choice is in **bold**.

| # | Gap in today's code | Recommendation |
|---|---|---|
| 1 | Org settings save actions (appearance, notifications, email, organization, AI, pipeline, currency) check only membership — any member can change them by calling the action | **Enforce role: manager+ for organization/pipeline/currency, admin for the rest** |
| 2 | Managers can invite someone as Admin | **Managers may invite member/manager only** |
| 3 | Last-admin demotion is silently ignored but reports success | **Return an error** |
| 4 | Server lets an owner's role be changed (only UI hides it) | **Block server-side** |
| 5 | Default deal stage "Hold" passes validation but fails the DB check | **Remove Hold from the picker** |
| 6 | Only 2 of 6 feature flags have a UI switch | **Add a Modules screen** |
| 7 | Lost reason is not enforced server-side on stage change / edit | **Enforce in `Deal_ValidateRules`** |
| 8 | Hold revisit date can be in the past | **Require a future date** |
| 9 | CSV import skips approval, forecast category, offerings, events, scoring | **Route each row through `Deal_Create`** |
| 10 | Board margin check uses "is null", form uses "> 0" | **Use > 0 everywhere** |
| 11 | Full-form save clears free-text company/contact labels | **Keep them** |
| 12 | Won/lost workflows and notifications fire only from the board | **Fire from shared stage-change logic** |
| 13 | `deals.probability` is stale; revenue-forecast report hard-codes 10/25/50/75 | **Use workspace stage probabilities everywhere; drop `Probability` after migration** |
| 14 | Two FY-proration rules (monthly for Support/AMC display vs day-overlap for targets) | **Confirm with finance; keep both but label clearly** |
| 15 | PI numbering uses Indian April–March FY regardless of workspace FY | **Keep (GST compliance), document** |
| 16 | Any member incl. viewer can create a PI; managers can't open other reps' PI PDF though they record payments | **Exclude viewer; let `recordPayments` open PDFs** |
| 17 | No overpayment guard; payment can predate the PI | **Add both checks** |
| 18 | PDF state line read from GSTIN only | **Use the selected state code** |
| 19 | `NormalizedName` not recomputed on rename; contact email uniqueness only on create | **Recompute on every save; check uniqueness on update** |
| 20 | Company/contact detail pages don't apply the sales scope (only lists do) | **Apply scope on detail too** (confirm with business — sales may need to view others' accounts) |
| 21 | Inline/bulk company owner change skips activity + notification | **Single owner-change action** |
| 22 | Collections uses face value; targets use quota-weighted value | **Confirm which is intended** |
| 23 | No receivables aging buckets | **Optional: add 0–30 / 31–60 / 61–90 / 90+** |
| 24 | Notification types `task_due_soon`, `automation_failed` never sent | **Implement due-soon timer; send automation_failed from job failures** |
| 25 | Pattern-learning deriver and orphan-email recovery never scheduled | **Schedule both** |
| 26 | Hard delete doesn't require soft delete first and isn't audited | **Require + audit** |
| 27 | `assignDeals` excludes admin while `approveDeals` includes admin | **Confirm; likely add admin** |
| 28 | Every new workspace silently gets `info@cgbindia.com` as an owner | **Confirm it is intended; make it a configuration** |
| 29 | `tasks.stage_blocking` stored but never enforced | **Drop or implement as a stage gate** |
| 30 | Recurring "custom" tasks roll +1 month (comment says +30 days) | **Confirm** |
| 31 | Pipeline settings, export, audit-log and date-history APIs need only membership | **Apply scope/role checks** |
| 32 | Sales persona only sees own + unassigned; there is no team hierarchy for managers | **Confirm; add a `ReportsTo` hierarchy only if needed** |

---

## 11. UAT scenarios (parity tests)

| # | Scenario | Expected |
|---|---|---|
| 1 | Member creates a deal at Lead with a close date | Rejected (R0 message) |
| 2 | Create at Proposal without close date | Rejected (R1) |
| 3 | Create at Qualified without margin | Rejected ("Margin % is required from Qualified onwards.") |
| 4 | Move Negotiation → Qualified without reason | NeedsRollbackReason; with reason → RollbackCount + 1, audit row `rollback` with reason |
| 5 | Move Proposal → Hold | Needs reason + revisit date; forecast category omitted; excluded from score/risk/stale |
| 6 | Push close date 4 times (later each time) | PushCount 4, QuotaWeight 0.50, TotalSlipDays = new − original; 4 DealDateChange rows `IsPush` |
| 7 | Pull close date earlier | Not a push; audit `edit` |
| 8 | Member moves a deal to Won | Approval pending; not counted in targets; appears in Approvals |
| 9 | Manager rejects it with a reason | Stage negotiation, ClosedAt null, approval rejected, audit rollback reason `approval_rejected` |
| 10 | Manager moves a deal to Won | Approved immediately |
| 11 | Stage gate "min 2 stakeholders, block" on Proposal; deal has 1 | Blocked with rule CTA; with severity warn → allowed + `gate_warning` |
| 12 | Offerings on; create deal without offering | Rejected; remove last offering from tagged deal → rejected |
| 13 | Value split 3 years, recurring ₹10,00,001 (in paise 100000100) | Year 1 gets the remainder; Σ = amount; Σ ≠ amount → "short of"/"exceeds" |
| 14 | Support element starting 1 Nov 2026, FY April | FY display 5/12 in FY2026–27, 7/12 in FY2027–28 |
| 15 | Board drag Qualified → Lead on a dated deal | Confirmation, then date cleared |
| 16 | Sales user opens the deal list | Only own + unassigned deals; export and search respect the same scope |
| 17 | Contact with an existing email | Blocked with link to existing contact |
| 18 | "Acme Pvt. Ltd." vs existing "ACME Limited" (dedup on) | Warning shows the existing company; create anyway → DedupOverride + activity |
| 19 | Merge two contacts | Deals, stakeholders, notes, tasks, emails re-pointed; loser hidden; MergeAudit row |
| 20 | PI with seller state 27 and buyer state 29 | IGST at full rate; same state → CGST/SGST halves |
| 21 | PI worked example (§6.13.3) | Total 305,559 paise |
| 22 | Second PI in FY 25-26 after deleting PI/25-26/002 of 3 | Next number PI/25-26/004 |
| 23 | Payment covering the total in two parts, last on day 40, credit 30 | Paid, collected late, days to collect 40 |
| 24 | Credit terms 45 days set by member, standard 30 | Needs approval; manager approves; later change to 50 → approval cleared |
| 25 | Incentive WB1–WB5, capped, full-step (§6.12.2) | Exact expected values |
| 26 | Bulk incentive change while another admin edits a plan | Apply refused ("Plans changed since the preview…") |
| 27 | Target 100 L, FY revenue 45 L at mid-year | Achievement 45 %, pace ratio 0.9 → on-track |
| 28 | Health score: deal with no activity, no stakeholders, amount 0 | 50 − 25 − 15 = 10 → at_risk (plus other applicable deltas) |
| 29 | Forecast with an overdue negotiation deal | In Overdue row, excluded from Commit; grand total = board total |
| 30 | Gmail email from a contact with 2 open deals | Attached to the most recently updated deal, `needsReview` |
| 31 | Gmail email from unknown address | Nothing stored |
| 32 | Send email twice with the same idempotency key | One message only |
| 33 | Ask Mira `act` token reused | Rejected (single-use) |
| 34 | Ask Mira people sync omits a member | Member suspended (owner never); access denied via API |
| 35 | Remove the last admin | Refused with message |
| 36 | Soft delete → restore → hard delete a deal (owner) | Hidden → visible → gone with children |
| 37 | Two tenants, same user: switch workspace | Data of the other tenant never visible |

---

## 12. Appendix A — formula sheet

| Formula | Definition |
|---|---|
| Minor units | `toMinor(x) = round(x × 10^d)`, d = 2 (JPY 0) |
| Margin | `MarginBps = round(pct × 100)`; `MarginMinor = round(Amount × bps / 10000)` |
| Unit pricing | `Amount = toMinor(UnitPrice) × Qty` |
| Weighted pipeline | `round(Σ Amount × StageProbability / 100)` |
| Quota weight | `0.50 if PushCount > 3 else 1.00`; weighted = `round(Amount × QuotaWeight)` |
| Slip days | `max(0, ExpectedCloseDate − OriginalCloseDate)` |
| Win rate | `won / (won + lost)` |
| Coverage | `open pipeline / max(0, target − achieved)` (≥ 3 healthy, ≥ 2 thin) |
| Pace | `achieved / round(target × elapsedFraction)` (≥ 1.05 ahead, ≥ 0.9 on-track, ≥ 0.7 behind) |
| Quarter target | Q1–Q3 = floor(annual / 4), Q4 = remainder |
| FY attribution | `Σ split.amount × overlapDays / periodDays` |
| Value split spread | base = floor(total / n), remainder → year 1 |
| Health score | 50 + Σ deltas (§6.8.1), clamp 0–100; ≥ 70 strong, ≥ 40 moderate |
| Risk score | Σ group points (§6.8.2) ≤ 100; ≥ 60 high, ≥ 30 elevated |
| Attention score | 0.35 stalled + 0.30 value + 0.20 regressed + 0.15 unset |
| Relationship score | 0.4 min(1, in/10) + 0.3 min(1, in/(out + unanswered)) + 0.3 max(0, 1 − silent/30) |
| GST | tax = round(subtotal × r/100) + round(shipping × rs/100); intra-state CGST = round(tax/2), SGST = tax − CGST |
| Collections due date | PI date + (PI credit days ?? deal agreed days ?? standard) |
| Incentive | §6.12.2 |
| Revenue forecast | likely = Σ amount × p; best = Σ amount; worst = Σ amount × p where p ≥ 50 |

## 13. Appendix B — glossary

| Term | Meaning |
|---|---|
| Workspace / tenant | One customer organisation; unit of data isolation |
| Persona | UX grouping of roles (admin, manager, sales) |
| SPOC | Single point of contact — the deal owner, used in the collections report |
| TCV | Total contract value (the deal amount) |
| Value split | Year × element breakdown of TCV |
| Push / pushback | Moving the expected close date later |
| Rollback | Moving a deal backward in the funnel |
| Quota weight | 50 % haircut on target credit after more than 3 pushes |
| Stage gate | Admin rule a deal must satisfy to enter a stage |
| Hold | Parking stage with reason and revisit date |
| PI | Proforma invoice |
| Gate / slab / step | Incentive plan revenue thresholds and increments |
| L / Cr | ₹ Lakh (100,000) / ₹ Crore (10,000,000) |
| Minor units | Paise/cents — integers used for all money |

---

*End of document.*
