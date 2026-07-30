import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * One row per change to `deals.expected_close_date` — pushes and pull-ins
 * alike. Maintained automatically by the `deal_close_date_pushback_sync`
 * trigger (see 0058) on every close-date UPDATE; the app never inserts here
 * directly, which is what makes the log complete regardless of which write
 * path moved the date.
 *
 * `isPush` records whether the change counted toward `deals.push_count` (a
 * forward move between two real dates). Setting a first date, clearing one,
 * and pulling a date in are all logged but none of them is a push.
 */
export const dealDateChanges = pgTable(
  'deal_date_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /** NULL on the first commitment (there was no prior date). */
    oldCloseDate: date('old_close_date'),
    /** NULL when the date was cleared (e.g. the deal went back to Lead). */
    newCloseDate: date('new_close_date'),
    /**
     * Actor id, same shape as `deals.updatedBy` — a text user id with no FK
     * (users live in an external directory). NULL when the writing path had no
     * actor GUC set.
     */
    changedBy: text('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Optional rep-supplied note, e.g. "client procurement delay". */
    reason: text('reason'),
    isPush: boolean('is_push').notNull().default(false),
  },
  (t) => [
    index('deal_date_changes_tenant_deal_idx').on(
      t.tenantId,
      t.dealId,
      t.changedAt,
    ),
  ],
);

export const dealDateChangesRelations = relations(dealDateChanges, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealDateChanges.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealDateChanges.dealId],
    references: [deals.id],
  }),
}));

export type DealDateChange = typeof dealDateChanges.$inferSelect;
export type NewDealDateChange = typeof dealDateChanges.$inferInsert;
