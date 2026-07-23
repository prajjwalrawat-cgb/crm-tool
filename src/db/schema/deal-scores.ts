import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * Append-only deal health score history (Module 2). One row per recompute, so
 * a per-deal trend line accumulates. The "current" score for a deal is the row
 * with the greatest `computed_at` (DISTINCT ON (deal_id) … ORDER BY computed_at
 * DESC). Never UPDATEd — a new score is always a new row.
 */
export const dealScores = pgTable(
  'deal_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /** 0–100, clamped. */
    score: smallint('score').notNull(),
    /** 'strong' | 'moderate' | 'at_risk'. */
    band: text('band').notNull(),
    /** Array<{signal, delta, detail}> — the full reason breakdown at compute time. */
    reasons: jsonb('reasons')
      .$type<Array<{ signal: string; delta: number; detail: string }>>()
      .notNull()
      .default([]),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Latest-per-deal lookup (DISTINCT ON deal_id ORDER BY computed_at DESC).
    index('deal_scores_deal_computed_idx').on(t.dealId, t.computedAt),
    index('deal_scores_tenant_deal_idx').on(t.tenantId, t.dealId),
  ],
);

export const dealScoresRelations = relations(dealScores, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealScores.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealScores.dealId],
    references: [deals.id],
  }),
}));

export type DealScore = typeof dealScores.$inferSelect;
export type NewDealScore = typeof dealScores.$inferInsert;
