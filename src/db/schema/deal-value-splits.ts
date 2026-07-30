import { relations } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { dealValueBillingType, dealValueComponent } from './enums';
import { tenants } from './tenants';

/**
 * Per-element, per-contract-year breakdown of a deal's total contract value.
 *
 * A deal holds ONE amount — the TCV — and that stays the figure the board,
 * forecast and targets read. These rows record how the total is spread, so a
 * three-year deal reports year by year without changing what any existing
 * total means.
 *
 * The grid is (element × year). A contract is usually a mix — a one-off
 * licence and implementation fee plus a recurring AMC — so each element
 * carries its own year profile. `elementIndex`, not `component`, is the
 * element's identity: a deal may legitimately have two `other` lines with
 * different labels.
 *
 * Years come from a contract start date: year 1 starts on that date, each
 * later year on the anniversary. Every cell is editable and the grid's grand
 * total must equal `deals.amount_minor` (enforced in
 * `saveDealValueSplitAction`). Currency is never stored here — a split is
 * always in the deal's currency.
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
    /** 1-based position of the element in the deal's grid — its identity. */
    elementIndex: smallint('element_index').notNull().default(1),
    /** Which commercial element this row belongs to. */
    component: dealValueComponent('component').notNull().default('other'),
    /** Required when `component` is 'other'; ignored otherwise. */
    componentLabel: text('component_label'),
    /**
     * Author's intent, and what the UI auto-fill uses. Not a constraint —
     * cells stay editable, because real contracts have exceptions (support
     * starting in year 2, a ramped licence).
     */
    billingType: dealValueBillingType('billing_type')
      .notNull()
      .default('recurring'),
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
    uniqueIndex('deal_value_splits_deal_element_year_uniq').on(
      t.dealId,
      t.elementIndex,
      t.yearIndex,
    ),
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
