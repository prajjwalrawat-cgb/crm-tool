import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { offerings } from './offerings';
import { tenants } from './tenants';

/**
 * What a deal is selling (0066). Many-to-many on purpose: a bundle — a
 * product plus the implementation service around it — is ONE deal that
 * belongs in BOTH offerings' funnels.
 *
 * `isPrimary` names the tag that best labels the deal. It drives the deals
 * table's single Offering chip and any rollup that must attribute a deal's
 * amount exactly once. It is NOT what the funnel-by-offering report filters
 * on: that report counts a deal toward every offering it carries, so its
 * per-offering values sum to MORE than total pipeline whenever bundles
 * exist. See the header of 0066 for why that is the intended reading.
 *
 * Exactly one primary per deal is enforced both in the actions (marking a new
 * primary clears the old one first) and by a partial unique index on
 * `(deal_id) WHERE is_primary` — the same belt-and-braces 0045 uses for
 * `deal_contacts`, because a second primary is silent corruption rather than
 * a visible error.
 */
export const dealOfferings = pgTable(
  'deal_offerings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    // NO ACTION: retiring an offering is `active = false`, never a DELETE.
    // The end-of-statement check still refuses to orphan a tag, while
    // leaving a tenant-wide cascade able to drop both tables — see 0066.
    offeringId: uuid('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'no action' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('deal_offerings_deal_offering_unique').on(
      t.dealId,
      t.offeringId,
    ),
    index('deal_offerings_tenant_deal_idx').on(t.tenantId, t.dealId),
    index('deal_offerings_tenant_offering_idx').on(t.tenantId, t.offeringId),
  ],
);

export const dealOfferingsRelations = relations(dealOfferings, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealOfferings.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealOfferings.dealId],
    references: [deals.id],
  }),
  offering: one(offerings, {
    fields: [dealOfferings.offeringId],
    references: [offerings.id],
  }),
}));

export type DealOffering = typeof dealOfferings.$inferSelect;
export type NewDealOffering = typeof dealOfferings.$inferInsert;
