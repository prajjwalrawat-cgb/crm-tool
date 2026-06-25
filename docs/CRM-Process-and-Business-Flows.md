# Multi-Tenant CRM — Process & Business Flows

**Document type:** Business process / functional overview
**Audience:** Product, engineering onboarding, QA, stakeholders
**Application:** `multi-tenant-crm` (Next.js 16, React 19, Drizzle ORM, Postgres, Clerk, Inngest, OpenAI)
**Status:** Living document — update as features change

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Who uses the system (personas & roles)](#2-who-uses-the-system-personas--roles)
3. [Core concepts & vocabulary](#3-core-concepts--vocabulary)
4. [Data model overview](#4-data-model-overview)
5. [System architecture](#5-system-architecture)
6. [End-to-end business flows](#6-end-to-end-business-flows)
   - 6.1 Tenant provisioning & onboarding
   - 6.2 Authentication & organization selection
   - 6.3 Team management (invite / role change / remove)
   - 6.4 Company & contact management
   - 6.5 Deal lifecycle (the core pipeline)
   - 6.6 Tasks, notes & comments
   - 6.7 Communications & email
   - 6.8 Reporting & dashboards
   - 6.9 AI / intelligence layer
   - 6.10 Real-time collaboration
   - 6.11 Soft delete & restore
   - 6.12 Background jobs & automation
7. [Cross-cutting rules & invariants](#7-cross-cutting-rules--invariants)
8. [Glossary](#8-glossary)

---

## 1. Executive summary

This is a **B2B Customer Relationship Management (CRM)** platform for sales teams. It is **multi-tenant**: many independent customer organizations use one deployment, and each organization's data is strictly isolated from every other.

The product helps a sales organization:

- Track **companies** (accounts they sell to) and **contacts** (people at those accounts).
- Manage **deals** (sales opportunities) as they progress through a defined pipeline until **won** or **lost**.
- Coordinate work via **tasks**, **notes**, and threaded **comments**.
- Communicate via an integrated **email / communications** module.
- Measure performance through **reports**, **executive dashboards**, and **per-rep analytics**.
- Get **AI assistance** — automated summaries, risk detection, recommendations, forecasting, and semantic search — that improves over time via a learning loop.
- Collaborate in **real time** — live presence, typing indicators, and instant cross-tab updates.

Three pillars differentiate it from a basic CRM:

| Pillar | What it delivers |
|---|---|
| **Multi-tenant isolation** | Defense-in-depth (app-level filtering **and** database Row-Level Security) guarantees one tenant can never see another's data. |
| **AI / intelligence** | Cached LLM insights, heuristic predictions, and a self-improving recommendation engine. |
| **Real-time collaboration** | SSE + Postgres `LISTEN/NOTIFY` push live updates, presence, and typing indicators. |

---

## 2. Who uses the system (personas & roles)

The system has **five roles** (stored on each user's membership) that collapse into **three UX personas**.

### Roles (authorization)

| Role | Capabilities |
|---|---|
| **owner** | Full control. The **only** role that can change other members' roles and permanently (hard) delete data. |
| **admin** | Manage all CRM data; invite/remove members. Cannot change roles or hard-delete. |
| **manager** | Team visibility (reports, performance, activity); can invite members. No destructive operations. |
| **member** | Read/write CRM data (their own and assigned records). No deletes. |
| **viewer** | Read-only. |

### Personas (UX views)

| Persona | Derived from roles | Sees |
|---|---|---|
| **admin** | owner, admin | System overview, ops, team, settings, all data |
| **manager** | manager | Team funnels, leaderboards, reports, communications |
| **sales** | member, viewer | Personal deals/accounts and KPIs (scoped to owned/assigned records) |

> **Rule:** A salesperson sees only deals they own or that are unassigned. Managers/admins see everything in the tenant. This is enforced **server-side**, not just in the UI.

---

## 3. Core concepts & vocabulary

- **Tenant** — one customer organization. 1:1 with a **Clerk Organization**.
- **Membership** — a user's link to a tenant, carrying their role and status (`active` / `invited` / `suspended`).
- **Company** — an account.
- **Contact** — a person, usually linked to a company.
- **Deal** — a sales opportunity with a monetary amount, currency, expected close date, and a **stage**.
- **Pipeline / Stage** — the lifecycle a deal moves through: `lead → qualified → proposal → negotiation → won / lost`.
- **Task** — actionable to-do, optionally attached to a deal/company/contact.
- **Note** — free-form human-written text attached to an entity.
- **Comment** — threaded discussion with @mentions.
- **Activity log** — append-only audit trail of every meaningful action.
- **Soft delete** — records are hidden (`deleted_at` set), not physically removed; they can be restored.

---

## 4. Data model overview

Every core table carries: `id`, `tenant_id`, `created_at`, `updated_at`, and (for CRM entities) soft-delete columns `deleted_at` / `deleted_by`.

```
tenants (1) ──────< memberships            (users in the org, with role/status)
   │
   ├──< companies ──< contacts ──< deals
   │          \________________/    │
   │                                 │ (deals optionally link to a company AND a contact)
   ├──< deals (stage, amount_minor, currency, expected_close_date, probability, owner_id)
   ├──< tasks   (polymorphic: entity_type + entity_id → deal/company/contact)
   ├──< notes   (polymorphic, human-authored)
   ├──< comments (threaded, @mentions)
   └──< activity_logs (append-only audit)
```

### Key field notes

| Entity | Important fields | Notes |
|---|---|---|
| **deals** | `stage`, `amount_minor`, `currency`, `expected_close_date`, `closed_at`, `probability` (0–100), `owner_id`, `company_id`, `contact_id`, `description` | **Money is stored in minor units (cents)** — never floats. |
| **contacts** | `first_name`, `last_name`, `email`, `phone`, `title`, `company_id`, `owner_id` | Linked to a company (nullable). |
| **companies** | `name`, `domain`, `industry`, `owner_id` | |
| **tasks** | `title`, `status`, `priority`, `due_date`, `assigned_user_id`, `entity_type`, `entity_id` | Polymorphic link is intentionally loose (no FK) because targets can be soft-deleted. |
| **activity_logs** | `actor_user_id`, `entity_type`, `entity_id`, `action`, `metadata` | Append-only; `actor_user_id` is null for system/automation events. |

### Enumerations

| Enum | Values |
|---|---|
| **deal_stage** | `lead`, `qualified`, `proposal`, `negotiation`, `won`, `lost` |
| **task_status** | `todo`, `in_progress`, `completed`, `cancelled` |
| **task_priority** | `low`, `medium`, `high`, `urgent` |
| **membership_role** | `owner`, `admin`, `manager`, `member`, `viewer` |
| **membership_status** | `active`, `invited`, `suspended` |

---

## 5. System architecture

```
                        ┌─────────────────────────────────────────────┐
                        │                Browser (React 19)            │
                        │  Server Components + Client Components        │
                        │  SSE subscription (realtime) + Server Actions │
                        └───────────────┬──────────────────────────────┘
                                        │ HTTPS
                        ┌───────────────▼──────────────────────────────┐
                        │            Next.js 16 (App Router)            │
                        │  middleware (Clerk auth + org gate)           │
                        │  Server Actions (mutations)                   │
                        │  Route handlers: /api/search, /api/realtime,  │
                        │     /api/ai, /api/intelligence, /api/webhooks │
                        └───┬───────────────┬───────────────┬──────────┘
                            │               │               │
              ┌─────────────▼──┐   ┌────────▼───────┐  ┌────▼─────────┐
              │  Postgres       │   │  Clerk (auth/   │  │  OpenAI      │
              │  + pgvector     │   │  organizations) │  │  (LLM +      │
              │  + RLS policies │   │  + webhooks     │  │  embeddings) │
              │  + LISTEN/NOTIFY│   └─────────────────┘  └──────────────┘
              └────────┬────────┘
                       │ events
              ┌────────▼────────┐
              │     Inngest      │  event-driven workflows + nightly crons
              │  (+ local        │  (deal-won/lost, embeddings, retention,
              │   dispatcher     │   relationship signals, analytics rollups)
              │   fallback)      │
              └──────────────────┘
```

### The two architectural ideas that govern everything

**A. Multi-tenancy with defense-in-depth**

1. **Application layer** — queries explicitly filter `WHERE tenant_id = ?`.
2. **Database layer (RLS)** — Postgres policies physically refuse rows that don't match the current tenant.

Every data operation runs inside a **tenant transaction** that (a) drops DB privileges to a non-superuser role so RLS applies, and (b) sets request-scoped settings (`app.tenant_id`, `app.user_id`) that the policies read. Context is carried through the request via `AsyncLocalStorage`.

> **Critical failure mode:** RLS **fails closed**. A query run *without* tenant context returns **zero rows, not an error**. "My data is empty" almost always means missing tenant context.

**B. Authentication & RBAC**

Clerk handles identity. A 1:1 mapping links each **Clerk Organization** to a **tenant**. Roles drive permissions; permissions are checked through shared guards (`requirePermission`, `checkPermission`, `can*` helpers). Because Clerk only natively supports `admin`/`member` org roles, the extra `manager` role is carried through invitations via a **pending role intents** table that is consumed when the invitee accepts.

---

## 6. End-to-end business flows

### 6.1 Tenant provisioning & onboarding

```
New customer signs up
   └─> Creates a Clerk Organization
         └─> Clerk fires `organization.created` webhook
               └─> App creates a `tenants` row (links clerk_org_id)
               └─> App creates an `owner` membership for the creator
   └─> Owner lands in /dashboard as persona = admin
```

- The first user of an org becomes **owner** automatically.
- Tenant + membership rows are created by the webhook handler running in a **system context** (actor = `system`).

### 6.2 Authentication & organization selection

```
Visit app
  ├─ Not signed in ─────────────> redirect to /sign-in (Clerk)
  ├─ Signed in, no org selected ─> redirect to /select-org
  └─ Signed in + org selected ──> /dashboard
```

- Public routes (no auth): `/sign-in`, `/sign-up`, `/api/webhooks/*`, `/api/inngest/*`.
- Selecting/creating an org sets the active `orgId`, which becomes the tenant context for all subsequent requests.

### 6.3 Team management (invite / role change / remove)

**Invite a member** (owner / admin / manager):

```
Inviter submits email + intended app role
  └─> App writes a `pending_role_intents` row (tenant + email → intended role)
  └─> App creates a Clerk organization invitation
  └─> Invitee receives email, accepts
        └─> Clerk fires `organizationMembership.created`
              └─> App resolves final role:
                    1) consume matching pending_role_intent  (primary)
                    2) else Clerk invitation metadata          (fallback)
                    3) else Clerk's native org role            (last resort)
              └─> App creates the `membership` row
```

**Change a role** (owner only): updates Clerk + local membership; `manager` is stored locally because Clerk has no native manager role.

**Remove a member** (owner / admin): protected against removing the last owner/admin; deletes from Clerk and locally; clears any stale pending intent.

> Every team action writes an **activity log** entry and emits a **realtime event**.

### 6.4 Company & contact management

```
Create company (member+) ──> validate (Zod) ──> insert (tenant tx)
   └─> activity log "created" + realtime "company.created"

Create contact ──> optionally link to a company ──> insert
   └─> activity log + realtime + queue AI embedding refresh

Edit / delete (soft) ──> update deleted_at  ──> activity log + realtime
```

- List pages are cursor-paginated, searchable, and filterable.
- Detail pages aggregate the entity plus its notes, comments, tasks, activity, and AI summary in parallel.

### 6.5 Deal lifecycle (the core pipeline)

This is the heart of the business application.

```
        ┌──────┐    ┌───────────┐    ┌──────────┐    ┌─────────────┐    ┌─────┐
        │ lead │──▶ │ qualified │──▶ │ proposal │──▶ │ negotiation │──▶ │ won │
        └──────┘    └───────────┘    └──────────┘    └─────────────┘    └─────┘
            │             │               │                 │              
            └─────────────┴───────────────┴─────────────────┴────────▶ │ lost │
                              (a deal can be marked lost from any stage)  └──────┘
```

**Creating a deal:**

```
Create deal (member+) with name, amount, currency, expected close, owner, links
  └─> insert (tenant tx)
  └─> activity log "created"
  └─> realtime "deal.created"
  └─> Inngest event `crm/deal.created`
  └─> queue AI embedding refresh
```

**Changing a deal's stage** (drag on the Kanban board, or inline edit):

```
Stage change requested
  └─> permission check (manageDeals)
  └─> update stage + (if won/lost) set closed_at  (tenant tx)
  └─> activity log "stage_changed" (from → to in metadata)
  └─> realtime "deal.stage_changed"  (all tabs/users update live)
  └─> Inngest event `crm/deal.stage_changed`
        ├─ to = won  ─> deal-won workflow  (record outcome +1, follow-ups)
        └─ to = lost ─> deal-lost workflow (record outcome -1)
  └─> AI summary marked stale → async regeneration
```

**Two deal views:**

- **List view** — paginated table, filters (stage / owner / company / amount), inline quick-edit, optimistic UI, **CSV bulk upload**.
- **Board view** — drag-and-drop Kanban grouped by stage, with per-stage counts; capped per column for performance.

**CSV bulk upload:** rows parsed and validated individually; a result panel reports per-row success/failure.

### 6.6 Tasks, notes & comments

```
Task: create with title/priority/due date/assignee, optionally linked to an entity
  └─> appears in /dashboard/tasks and on the linked entity's detail page
  └─> complete ──> status=completed, completed_at set ──> activity log

Note: free-form text attached to a deal/company/contact (newest first)
Comment: threaded discussion with @mentions ──> mention triggers notification
```

All three emit realtime events; comments and notes support live typing indicators.

### 6.7 Communications & email

```
Shared inbox (admin/manager) with folders:
  Inbox │ Sent │ Drafts │ Failed │ Archived

Compose ──> draft auto-saves (debounced) ──> send
   └─> email send integration
   └─> failed deliveries surface in "Failed" with a badge
   └─> threads grouped; thread summaries available via AI
```

- Draft auto-save handles multi-tab edits and version conflicts (server is canonical).
- Threads can be linked to deals/companies/contacts and analyzed for risk (e.g., long silence).

### 6.8 Reporting & dashboards

| Surface | Audience | Content |
|---|---|---|
| **/dashboard** (home) | all (persona-aware) | Admin overview / manager funnels / personal KPIs |
| **/dashboard/reports** | manager, admin | Pipeline by stage, win/loss, revenue forecast, rep performance, deal velocity, email engagement |
| **/dashboard/executive** | manager, admin | One-screen business health: revenue, pipeline, top performers, bottlenecks, risks |
| **/dashboard/command-center** | admin | Predictive signals, top recommendations, risk alerts, 24h activity |
| **/dashboard/my-performance** | all (self-scoped) | Personal KPIs, ranking, AI coaching |
| **Chart Studio** | — | Configurable revenue/conversion/stage charts (Recharts) |

### 6.9 AI / intelligence layer

Three tiers, all tenant-scoped, cached, and audited.

```
1) LLM INSIGHTS (OpenAI)
   deal summary │ daily exec summary │ pipeline narrative │
   risk flags │ recommendations │ thread summaries
   └─> cached in ai_summaries keyed by content hash
   └─> stale content ──> async regeneration (reads never block)

2) HEURISTIC PREDICTIONS (pure SQL, no ML)
   close_probability │ deal_momentum │ stale_risk │ comm_risk

3) AGENT LEARNING LOOP
   every mutation ──> agent_observations (append-only)
   nightly job ──> derive agent_patterns (e.g., "follow-up within 24h ⇒ higher win rate")
   patterns gently re-rank recommendations
   user accept/dismiss ──> feedback ──> improves future ranking
```

**Operational safety nets:**

- **AI mode:** `live` (real API) / `mock` (deterministic stub when `AI_ENABLED=false`) / `disabled` (misconfig fallback). The full pipeline runs in mock mode — you can develop without API keys.
- **Per-tenant daily token budget** — over-budget calls are skipped gracefully.
- **Every AI call** is logged to `ai_invocations` (tokens, latency, status) for cost tracking.
- **Semantic search** — entity text embedded into a `vector(1536)` column (HNSW index), queried by cosine distance; powers global/Copilot search.

### 6.10 Real-time collaboration

```
Server action mutates data
   └─> publishes event via Postgres NOTIFY on channel tenant:<id>
         └─> SSE endpoint (/api/realtime/events) pushes to subscribed browsers
               └─> client hooks update UI instantly:
                     • use-realtime-events    (entity create/update/delete)
                     • use-typing-indicators  ("X is typing…")
                     • use-entity-viewers     ("X is viewing this deal")
                     • use-draft-autosave     (cross-tab draft sync)
```

Events are de-duplicated by UUID and tenant-checked client-side as a second line of defense.

### 6.11 Soft delete & restore

```
Delete (soft) ──> set deleted_at + deleted_by ──> hidden by RLS by default
   └─> appears in /dashboard/recently-deleted
         ├─ Restore (admin) ──> clear deleted_at
         └─ Permanent delete (owner only) ──> physical removal
```

### 6.12 Background jobs & automation (Inngest)

| Trigger | Job | Purpose |
|---|---|---|
| `crm/deal.stage_changed` (→won) | deal-won | Record positive outcome, schedule follow-ups |
| `crm/deal.stage_changed` (→lost) | deal-lost | Record negative outcome |
| `crm/ai.embed_entity` | regenerate-embedding | Refresh semantic search vector |
| `crm/member.invited` | new-member-onboarding | Onboarding email + setup tasks |
| nightly cron | relationship-signals-derive | Refresh relationship health counters |
| nightly cron | stale-deals-scan | Flag stalled deals |
| nightly cron | communication-analytics-rollup | Aggregate email/thread analytics |
| nightly cron | retention jobs | Trim old workflow runs / notifications |

Runs are tracked in `workflow_runs` and visible at `/dashboard/workflows`. A **local dispatcher fallback** runs workflows in development even without the Inngest dev server.

---

## 7. Cross-cutting rules & invariants

These are the non-negotiable rules that keep the system correct:

1. **Every data operation runs in tenant context.** Missing context returns 0 rows, not an error.
2. **Never hard-delete** in normal flows — set `deleted_at`. Hard delete is owner-only.
3. **Money is in minor units (cents).** Never store or compare floats.
4. **All permission checks go through the shared RBAC guards.** No ad-hoc role checks.
5. **User actions record an activity log entry and emit a realtime event.**
6. **AI reads never block on the model** — stale insights regenerate asynchronously.
7. **The framework is a modified Next.js 16** — conventions differ from standard Next.js; consult the in-repo docs before writing framework code.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Tenant** | A customer organization; the unit of data isolation. |
| **RLS** | Row-Level Security — Postgres-enforced per-row access control. |
| **Persona** | UX grouping of roles (admin / manager / sales). |
| **Pending role intent** | Stored intended app-role for an invited email, consumed on acceptance. |
| **Soft delete** | Hiding a record via `deleted_at` instead of physical removal. |
| **Pipeline stage** | A deal's position in the sales process (`lead`…`won`/`lost`). |
| **Embedding** | A vector representation of entity text enabling semantic search. |
| **Activity log** | Append-only audit trail of actions. |
| **SSE** | Server-Sent Events — the transport for real-time updates. |
| **Inngest** | The background-job / workflow engine. |

---

*End of document.*
