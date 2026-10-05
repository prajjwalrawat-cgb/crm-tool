import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/*
 * Sales incentive plans (migration 0068). See docs/incentive-calculator.md.
 *
 * UNITS. Plan terms are in the workbook's own units — compensation in ₹ Lakh,
 * revenue in ₹ Crore, ratios as fractions — and stored as fixed-point
 * `numeric`, never float. Drizzle returns numeric as a decimal STRING, which
 * the engine parses exactly; nothing converts these to a JS number before the
 * engine has run.
 *
 * Scales: ₹ L at 5 dp (= ₹1), ₹ Cr at 7 dp (= ₹1), fractions at 6 dp.
 *
 * TENANCY. All four tables are RLS-scoped by tenant (uuid predicate, 0059
 * style) and every query also filters on tenant_id explicitly. Per-USER
 * scoping (a SPOC reads only their own plan) is enforced in
 * `lib/incentives/access`, because the role a policy would need isn't in the
 * session GUCs.
 */

const lakh = (name: string) => numeric(name, { precision: 14, scale: 5 });
const crore = (name: string) => numeric(name, { precision: 16, scale: 7 });
const fraction = (name: string) => numeric(name, { precision: 9, scale: 6 });

/** The rule columns shared by a plan and the tenant template. */
const termColumns = () => ({
  fixedCtc: lakh('fixed_ctc').notNull(),
  targetVariable: lakh('target_variable').notNull(),
  gateRevenueCr: crore('gate_revenue_cr').notNull(),
  gateIncentiveL: lakh('gate_incentive_l').notNull(),
  slab1UpperCr: crore('slab1_upper_cr').notNull(),
  slab1RateL: lakh('slab1_rate_l').notNull(),
  slab2RateL: lakh('slab2_rate_l').notNull(),
  stepCr: crore('step_cr').notNull().default('1'),
  /** 'pro_rata' | 'full_step_only' (CHECK in 0068). */
  accrualBasis: text('accrual_basis').notNull().default('pro_rata'),
  capEnabled: boolean('cap_enabled').notNull().default(false),
  capAmountL: lakh('cap_amount_l'),
  priorYearCreditPct: fraction('prior_year_credit_pct').notNull().default('0.25'),
  netNewCreditPct: fraction('net_new_credit_pct').notNull().default('1'),
  marginFloorPct: fraction('margin_floor_pct').notNull().default('0.2'),
  /** 'pro_rata' | 'nil' | 'ignore' (CHECK in 0068). */
  marginMissTreatment: text('margin_miss_treatment').notNull().default('pro_rata'),
});

/**
 * One plan per resource per fiscal year. `fiscalYear` is the STARTING
 * calendar year, exactly as `sales_targets.fiscal_year` (labelled with
 * `fiscalYearLabel`), rather than a free-text "FY" label that two admins
 * could spell two ways.
 *
 * `version` increments on every change; the full history, with who and
 * what, is `incentive_plan_versions`. An edit therefore never silently
 * overwrites: the prior terms stay readable, and the editor must send the
 * version it loaded (optimistic concurrency) or the save is refused.
 */
export const incentivePlans = pgTable(
  'incentive_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The resource (SPOC). Matches memberships.user_id / deals.owner_id. */
    userId: text('user_id').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    ...termColumns(),
    /** 'draft' | 'active' | 'closed'. Only an active plan shows to the SPOC. */
    status: text('status').notNull().default('draft'),
    /**
     * Which actuals the calculator reads: 'manual' (entered) or 'computed'
     * (nightly job from deal data). Switched only by an explicit admin
     * action, which is versioned like any other change.
     */
    actualsSource: text('actuals_source').notNull().default('manual'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('incentive_plans_tenant_user_fy_unique').on(t.tenantId, t.userId, t.fiscalYear),
    index('incentive_plans_tenant_fy_idx').on(t.tenantId, t.fiscalYear),
  ],
);

/**
 * Append-only audit trail + version history for plans. One row per change:
 * who, when, which fields moved (old → new), and the full terms after the
 * change. app_user may only SELECT and INSERT; an UPDATE or DELETE is
 * rejected by trigger.
 *
 * Deliberately NOT `activity_logs`: that table feeds the tenant-wide activity
 * stream every rep can read, and these rows carry CTC.
 */
export const incentivePlanVersions = pgTable(
  'incentive_plan_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => incentivePlans.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** created | updated | bulk_updated | status_changed | actuals_source_changed */
    action: text('action').notNull(),
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** { field: { from, to } } — empty object for a create. */
    changes: jsonb('changes').$type<Record<string, { from: unknown; to: unknown }>>().notNull().default({}),
    /** Full plan state after this change (terms + status + actualsSource). */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('incentive_plan_versions_plan_version_unique').on(t.planId, t.version),
    index('incentive_plan_versions_tenant_plan_idx').on(t.tenantId, t.planId, t.changedAt),
  ],
);

/**
 * Actuals history — never overwritten. Manual entries always append a row.
 * Computed rows are one per (plan, as_of_date): a same-day re-run replaces
 * that day's figure (a full recomputation, not an increment, so re-running
 * can't double-count), while earlier days stay as the history series.
 *
 * The calculator reads the latest row whose `source` matches the plan's
 * `actuals_source`.
 */
export const incentiveActuals = pgTable(
  'incentive_actuals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => incentivePlans.id, { onDelete: 'cascade' }),
    asOfDate: date('as_of_date').notNull(),
    priorYearRevenueCr: crore('prior_year_revenue_cr').notNull(),
    netNewRevenueCr: crore('net_new_revenue_cr').notNull(),
    blendedMarginPct: fraction('blended_margin_pct').notNull(),
    /** 'manual' | 'computed'. */
    source: text('source').notNull(),
    /** Who typed a manual entry. NULL for computed rows. */
    enteredBy: text('entered_by'),
    computedAt: timestamp('computed_at', { withTimezone: true }),
    /**
     * For computed rows: what was counted and — more importantly — what was
     * EXCLUDED and why (untagged, non-INR, margin unknown). See
     * `ComputedActualsDetails` in lib/incentives/actuals-compute.
     */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incentive_actuals_plan_created_idx').on(t.planId, t.createdAt),
    index('incentive_actuals_tenant_plan_idx').on(t.tenantId, t.planId),
  ],
);

/**
 * Tenant-level defaults a new plan starts from, plus the incentive budget
 * the roll-up compares projected spend against. One row per tenant, created
 * lazily with the workbook's default plan.
 */
export const incentivePlanTemplates = pgTable('incentive_plan_templates', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  ...termColumns(),
  /** ₹ L. Total incentive budget for the FY; NULL = not set. */
  budgetL: lakh('budget_l'),
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const incentivePlansRelations = relations(incentivePlans, ({ one }) => ({
  tenant: one(tenants, { fields: [incentivePlans.tenantId], references: [tenants.id] }),
}));

export type IncentivePlanRow = typeof incentivePlans.$inferSelect;
export type NewIncentivePlanRow = typeof incentivePlans.$inferInsert;
export type IncentivePlanVersionRow = typeof incentivePlanVersions.$inferSelect;
export type IncentiveActualsRow = typeof incentiveActuals.$inferSelect;
export type IncentivePlanTemplateRow = typeof incentivePlanTemplates.$inferSelect;
