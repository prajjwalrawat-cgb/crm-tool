import { bigint, integer, pgView, timestamp, uuid } from 'drizzle-orm/pg-core';

import { dealStage } from './enums';

/**
 * Drizzle handle for the `company_rollups` VIEW created in migration 0065.
 *
 * `.existing()` means "this object is declared here, but drizzle must not
 * try to create or diff it" — the view's body is SQL, lives in the
 * migration, and is the single definition of what each column means. Do
 * not restate the aggregation logic here; read `0065_company_rollups.sql`
 * for the contract (which deals count as open, what last_activity_at
 * covers, and why the aggregates are LATERAL rather than GROUP BY).
 *
 * Joining this to `companies` re-scans `companies` inside the view, so
 * the plan pays one primary-key probe per row. That is deliberate: the
 * alternative — inlining the same five laterals into every call site —
 * put the definition in TypeScript where a chip and a column could drift
 * apart again, which is the bug the view exists to close.
 *
 * MONEY is minor units (see `deals.amount_minor`), summed across whatever
 * currencies an account's deals carry. Format it with the tenant's
 * default currency via `lib/currency/format`.
 */
export const companyRollups = pgView('company_rollups', {
  companyId: uuid('company_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  /** Every non-deleted deal on the account, any stage. */
  dealCount: integer('deal_count').notNull(),
  /** Deals whose stage is neither `won` nor `lost` (`hold` is open). */
  openDealCount: integer('open_deal_count').notNull(),
  wonDealCount: integer('won_deal_count').notNull(),
  /** SUM(amount_minor) over open deals. 0, never NULL. */
  openPipelineValue: bigint('open_pipeline_value', { mode: 'number' }).notNull(),
  /** SUM(amount_minor) over `won` deals. 0, never NULL. */
  wonLifetimeValue: bigint('won_lifetime_value', { mode: 'number' }).notNull(),
  /**
   * Stage of the most recently updated OPEN deal, or NULL when the
   * account has none. NULL here and `openDealCount === 0` always agree.
   */
  topStage: dealStage('top_stage'),
  contactCount: integer('contact_count').notNull(),
  /**
   * Newest of: a company activity_logs row, a company note, or any deal's
   * `updated_at`. NULL for an account nothing has ever happened to.
   */
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
}).existing();

export type CompanyRollup = typeof companyRollups.$inferSelect;
