import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deals } from './deals';
import { tenants } from './tenants';

/**
 * Phase 1 deal risk scores (migration 0062). One row per OPEN deal —
 * upserted by the nightly job, deleted when the deal closes.
 *
 * Deliberately not append-only, unlike `deal_scores`: this answers "how risky
 * is this deal now", and a daily row per open deal would grow without ever
 * being read. See the migration for the rest of the reasoning.
 *
 * `score` is 0–100 where HIGH IS BAD — the inverse of `deals.health_score`.
 * Anything rendering both must say which is which.
 */
export const dealRiskScores = pgTable(
  'deal_risk_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'cascade' }),
    /** 0–100, higher = more risk. */
    score: smallint('score').notNull(),
    /** 'low' | 'elevated' | 'high'. */
    band: text('band').notNull(),
    /** The full factor breakdown at compute time, heaviest first. */
    factors: jsonb('factors')
      .$type<
        Array<{ key: string; label: string; points: number; detail: string }>
      >()
      .notNull()
      .default([]),
    /** The signal values the score was computed from, for auditing. */
    signals: jsonb('signals')
      .$type<Record<string, number | string | null>>()
      .notNull()
      .default({}),
    /** Claude's one-line "why". NULL until the explainer runs for this hash. */
    explanation: text('explanation'),
    explanationModel: text('explanation_model'),
    explainedAt: timestamp('explained_at', { withTimezone: true }),
    /** Cache key — the explanation regenerates only when this changes. */
    signalsHash: text('signals_hash').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('deal_risk_scores_deal_unique').on(t.dealId),
    index('deal_risk_scores_tenant_score_idx').on(t.tenantId, t.score),
  ],
);

export const dealRiskScoresRelations = relations(dealRiskScores, ({ one }) => ({
  tenant: one(tenants, {
    fields: [dealRiskScores.tenantId],
    references: [tenants.id],
  }),
  deal: one(deals, {
    fields: [dealRiskScores.dealId],
    references: [deals.id],
  }),
}));

export type DealRiskScore = typeof dealRiskScores.$inferSelect;
export type NewDealRiskScore = typeof dealRiskScores.$inferInsert;
