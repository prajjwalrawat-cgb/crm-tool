import { relations } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * Per-contract-year breakdown of a deal's total contract value.
 *
 * A deal holds ONE amount — the TCV — and that stays the figure the board,
 * forecast and targets read. These rows record how the total is spread across
 * the contract's years so a three-year deal can be reported year by year
 * without changing what any existing total means.
 *
 * Rows are generated from a contract start date: year 1 starts on that date,
 * each later year on the anniversary. Amounts are editable per year and must
 * sum to `deals.amount_minor` (enforced in `saveDealValueSplitAction`).
 * Currency is never stored here — a split is always in the deal's currency.
 */
export const dealValueSplits = pgTable(
  'deal_value_splits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /** 1-based contract year. */
    yearIndex: smallint('year_index').notNull(),
    /** Inclusive start of this contract year. */
    periodStart: date('period_start').notNull(),
    /** Exclusive end (== the next year's start). */
    periodEnd: date('period_end').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('deal_value_splits_deal_year_uniq').on(t.dealId, t.yearIndex),
    index('deal_value_splits_tenant_deal_idx').on(t.tenantId, t.dealId),
  ],
);

export const dealValueSplitsRelations = relations(dealValueSplits, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealValueSplits.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealValueSplits.dealId],
    references: [deals.id],
  }),
}));

export type DealValueSplit = typeof dealValueSplits.$inferSelect;
export type NewDealValueSplit = typeof dealValueSplits.$inferInsert;
