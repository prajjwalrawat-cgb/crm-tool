import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Annual sales targets per team member, benchmarked on two parameters:
 * Revenue and Margin (both absolute currency amounts, in minor units).
 *
 * Set by an admin from the backend (Settings → Targets). Achievement is
 * measured against Won + manager-approved deals whose close date falls in
 * the fiscal year.
 *
 * `fiscalYear` is the STARTING calendar year of the workspace fiscal year
 * (driven by organization_settings.fiscal_year_start_month). e.g. with an
 * April start, fiscalYear 2026 spans Apr 2026 → Mar 2027.
 *
 * Tenant isolation is enforced by always filtering on `tenant_id`
 * explicitly (same pattern as `org_invitations`), so this table is
 * read/written via the unrestricted `db` rather than under RLS.
 */
export const salesTargets = pgTable(
  'sales_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The sales member this target belongs to (matches deals.owner_id). */
    userId: text('user_id').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    revenueTargetMinor: bigint('revenue_target_minor', { mode: 'number' })
      .notNull()
      .default(0),
    marginTargetMinor: bigint('margin_target_minor', { mode: 'number' })
      .notNull()
      .default(0),
    currency: text('currency').notNull().default('USD'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('sales_targets_tenant_user_year_unique').on(
      t.tenantId,
      t.userId,
      t.fiscalYear,
    ),
    index('sales_targets_tenant_year_idx').on(t.tenantId, t.fiscalYear),
  ],
);

export type SalesTarget = typeof salesTargets.$inferSelect;
export type NewSalesTarget = typeof salesTargets.$inferInsert;
