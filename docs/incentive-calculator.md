# Sales Incentive Calculator

Per-resource, admin-configured incentive plans that mirror the "Sales Lead: Incentive Plan"
workbook (Plan Summary / Inputs / Calculator / Ladder), with a live calculator for each SPOC
and a roll-up for managers and admins.

## Where things are

| Piece | Path |
| --- | --- |
| Calculation engine (pure, client-safe) | `src/lib/incentives/engine.ts` (+ `rational.ts`) |
| Access rule | `src/lib/incentives/access.ts` |
| Term catalogue / diff | `src/lib/incentives/terms.ts` |
| Bulk preview, roll-up | `src/lib/incentives/bulk.ts`, `rollup.ts` |
| Reads, versioned writes | `src/lib/incentives/queries.ts`, `mutations.ts` |
| Computed actuals (Phase 4) | `src/lib/incentives/actuals-compute.ts`, `src/lib/inngest/workflows/incentive-actuals-nightly.ts` |
| Schema / migration | `src/db/schema/incentives.ts`, `drizzle/0068_incentive_plans.sql`, `scripts/apply-0068.ts` |
| SPOC page | `/dashboard/my-incentive` |
| Roll-up, per-resource view | `/dashboard/incentives`, `/dashboard/incentives/[planId]` |
| Admin: template, plans, bulk | `/dashboard/settings/incentives`, `…/plan`, `…/bulk` |
| API | `GET /api/incentives/plans/[planId]` (`?prior=&netNew=&margin=` for a what-if) |
| Tests | `scripts/selftest-incentives.ts` (+ `selftest-incentives-db.ts` with a database) |
| Seed | `pnpm seed:incentives --tenant=<uuid> [--users=a,b,c]` |

## Step 0: what the codebase already had

| Spec need | Found | Decision |
| --- | --- | --- |
| Who is a SPOC / admin | `memberships.role` → personas: member/viewer = sales, manager, owner/admin = admin. No reporting hierarchy. | SPOC = anyone with a plan. Two new permissions: `manageIncentives` (owner, admin) and `viewTeamIncentives` (owner, admin, manager). Managers see the whole workspace, the same as on Targets. |
| Recognised revenue by period | `deal_value_splits` (per element × contract year, with dates) and `lib/targets/fy-attribution` (date-overlap proration). Splitless deals are treated as single-year. | Reused as-is: incentives and target attainment count the same deal the same way. |
| Prior-year vs net-new tag | No tag, but derivable from `deals.closed_at` against the FY start. | No new column. Closed before FY start = carry-forward; closed inside = net-new. |
| Per-deal margin | `deals.margin_bps`, nullable. | Blended margin = revenue-weighted over deals that have a margin. |
| Compensation tables | Only `sales_targets` (revenue/margin targets). | New tables (below). |
| Tenant settings / FY | `organization_settings.fiscal_year_start_month`; `lib/targets/fiscal` (`fiscalYear` = starting year). | Plans key on integer `fiscal_year`, like `sales_targets`, not a free-text `fy_label`. |
| Audit mechanism | `activity_logs` feeds the tenant-wide activity stream that every rep can read. | **Not used**: these entries carry CTC. A dedicated append-only `incentive_plan_versions` table is the audit trail. |
| Inngest | Cron pattern + `workflow_runs` tracking. | `incentive-actuals-nightly` (01:40 UTC). |
| Notification sender | Exists. | Not used in this pass. |

### Data gaps, and how each is handled

1. **Won deals with no `closed_at`** can't be classed as prior-year or net-new. They are excluded from computed actuals, counted, and disclosed on the page.
2. **Deals not in INR** are excluded and disclosed. Plans are in ₹ L / ₹ Cr, and there is no FX table.
3. **Deals with no `margin_bps`** count toward revenue but are left out of the blended margin, and the revenue left out is disclosed. Entering them at 0% would trigger a margin cut the SPOC didn't earn.
4. **Won deals with no value breakdown** use the existing single-year assumption: full value in the close year. Disclosed.
5. **Pending-approval won deals** are not credited (same rule as Targets) and are disclosed.

Gaps 1–3 are data-entry gaps. Making `closed_at` and `margin_bps` mandatory at Won, and adding an FX table, would close them.

## Data model (migration 0068)

- `incentive_plans`: one per (tenant, user, fiscal_year). Terms are fixed-point `numeric` (₹ L at 5 dp, ₹ Cr at 7 dp, fractions at 6 dp). Also holds `status` (draft/active/closed), `actuals_source` (manual/computed) and `version`. CHECK constraints back up the engine's validation.
- `incentive_plan_versions`: append-only. Each row records who, when, `{field: {from, to}}` and a full snapshot. UPDATE, DELETE and TRUNCATE are revoked from `app_user`, and a trigger refuses UPDATE for every other role. The revoke is needed because 0004's default privileges grant `app_user` UPDATE and DELETE on every new table (0060 hit the same problem).

The app may not DELETE from any of the four tables. Supabase's `anon` and `authenticated` roles get no access to them at all.
- `incentive_actuals`: history, never overwritten. Each manual entry appends a new row. Computed rows are unique per plan per day, so a re-run replaces that day's figure rather than adding a second one. The calculator reads the latest row whose source matches the plan's `actuals_source`.
- `incentive_plan_templates`: the tenant's default terms plus an optional FY budget (₹ L) for the roll-up.

All four tables are tenant-scoped under RLS, and queries also filter on `tenant_id`. Per-user scoping lives in `access.ts`, because the viewer's role isn't available to a policy.

## Engine

`calculateIncentive(plan, actuals)` runs the workbook's steps 1–18 in order. Arithmetic is exact (BigInt rationals) and rounded once at the output to 6 dp. With plain floats, `0.18 / 0.20 × 6` gives 5.3999999999999995 instead of the workbook's 5.4. Every screen, the API, the bulk preview and the roll-up call the engine. `selftest-incentives` scans the UI and API source to make sure none of them does arithmetic on plan terms.

### Deliberate deviations from the spec's reverse formula

`creditedRevenueForFullTarget` uses the spec formula unchanged for `pro_rata`. It handles three cases the formula doesn't:

- **`full_step_only`**: the answer is rounded *up* to the step boundary where payout actually lands. Otherwise a SPOC who hits the quoted figure would still fall short.
- **Cap below target**: reported as unreachable, not as a number.
- **Zero rate on the slab that would carry the remainder**: reported as unreachable.

### Other decisions worth knowing

- **Who can edit actuals.** Manual actuals can be entered by the plan's SPOC or an admin, as the spec asks. Every entry is attributed and shown ("entered by …").
- **What SPOCs see.** A SPOC sees only active or closed plans. Drafts are visible to managers and admins only.
- **Optimistic concurrency.** Edits carry the version they loaded, and a stale save is refused. Bulk apply is refused if any plan changed since the preview.
- **Template changes.** Changing the template never touches existing plans. Changes to existing plans go through the bulk tool, which previews first.

## Verification

`pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-incentives.ts` runs:

- all six workbook examples;
- the edge cases: exactly at the gate, exactly at `slab1Upper`, negative or missing actuals rejected;
- the three seed shapes, hand-checked;
- determinism (100 runs) and exactness;
- the reverse-calculation cases, ladder highlighting, margin callout states, the next-step slab, the access rule, the bulk preview against a hand-computed delta, roll-up totals equal to the row sum, and the source-level single-code-path guard.

The DB half was first run against a throwaway in-memory Postgres (PGlite) with migrations 0000–0068 replayed, not against Supabase. Role and grant behaviour on Supabase can differ, so re-run it against a non-production database when one is available.

With `DATABASE_URL` set, the DB half also checks:

- the prior-year vs net-new split;
- untagged deals excluded and flagged;
- idempotent re-runs;
- explicit source switching;
- version conflicts;
- an attributed, diffed and immutable audit trail;
- SPOC and tenant isolation through the query layer and RLS.
