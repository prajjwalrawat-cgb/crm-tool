import { relations } from 'drizzle-orm';
import { index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { dealStage } from './enums';
import { tenants } from './tenants';

/**
 * One row per (deal, stage) occupancy interval. Maintained automatically by
 * the `deal_stage_history_sync` trigger (see 0045) on every deal INSERT and
 * stage UPDATE — the app never writes here directly. `exitedAt` NULL marks the
 * deal's current stage; time-in-stage = now() - enteredAt.
 */
export const dealStageHistory = pgTable(
  'deal_stage_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    stage: dealStage('stage').notNull(),
    enteredAt: timestamp('entered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    exitedAt: timestamp('exited_at', { withTimezone: true }),
  },
  (t) => [
    index('deal_stage_history_deal_idx').on(t.dealId, t.enteredAt),
    index('deal_stage_history_tenant_stage_idx').on(t.tenantId, t.stage),
  ],
);

export const dealStageHistoryRelations = relations(
  dealStageHistory,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [dealStageHistory.tenantId],
      references: [tenants.id],
    }),
    deal: one(deals, {
      fields: [dealStageHistory.dealId],
      references: [deals.id],
    }),
  }),
);

export type DealStageHistory = typeof dealStageHistory.$inferSelect;
export type NewDealStageHistory = typeof dealStageHistory.$inferInsert;
