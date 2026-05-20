import { relations } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { aiSummaries } from './ai-summaries';
import { tenants } from './tenants';

/**
 * Closes the recommendation feedback loop. One row per (tenant,
 * recommendation, user) — subsequent verdicts UPDATE the same row so
 * the latest signal wins.
 *
 * `recommendation_id` links back to the `ai_summaries` row that
 * carried the recommendation set the user reacted to. Cascading
 * delete keeps it clean if a summary is purged.
 *
 * `entity_type` / `entity_id` capture the specific deal/contact the
 * recommendation was about — lets us aggregate "do reps accept
 * recommendations on negotiation-stage deals more often than
 * proposal-stage?" without joining back to model output.
 */
export const AGENT_FEEDBACK_VERDICTS = [
  'accepted',
  'ignored',
  'dismissed',
  'completed',
] as const;
export type AgentFeedbackVerdict = (typeof AGENT_FEEDBACK_VERDICTS)[number];

export const agentRecommendationFeedback = pgTable(
  'agent_recommendation_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => aiSummaries.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    verdict: text('verdict').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('agent_recommendation_feedback_unique').on(
      t.tenantId,
      t.recommendationId,
      t.userId,
    ),
    index('agent_recommendation_feedback_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.createdAt,
    ),
  ],
);

export const agentRecommendationFeedbackRelations = relations(
  agentRecommendationFeedback,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [agentRecommendationFeedback.tenantId],
      references: [tenants.id],
    }),
    recommendation: one(aiSummaries, {
      fields: [agentRecommendationFeedback.recommendationId],
      references: [aiSummaries.id],
    }),
  }),
);

export type AgentRecommendationFeedback =
  typeof agentRecommendationFeedback.$inferSelect;
export type NewAgentRecommendationFeedback =
  typeof agentRecommendationFeedback.$inferInsert;
