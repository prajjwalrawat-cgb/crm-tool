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
 * AI insight feedback. One row per (user, summary) — subsequent verdicts
 * UPDATE the same row, so a thumbs-down replaces a previous thumbs-up
 * rather than fanning out.
 *
 * verdict values:
 *   - 'helpful'      thumbs up
 *   - 'not_helpful'  thumbs down
 *   - 'dismissed'    user closed the card without rating
 *
 * The aggregated read query (helpful-rate per entityType) feeds prompt
 * tuning. v1 just collects.
 */
export const AI_FEEDBACK_VERDICTS = [
  'helpful',
  'not_helpful',
  'dismissed',
] as const;
export type AiFeedbackVerdict = (typeof AI_FEEDBACK_VERDICTS)[number];

export const aiFeedback = pgTable(
  'ai_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    summaryId: uuid('summary_id')
      .notNull()
      .references(() => aiSummaries.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
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
    uniqueIndex('ai_feedback_user_summary_unique').on(
      t.tenantId,
      t.summaryId,
      t.userId,
    ),
    index('ai_feedback_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export const aiFeedbackRelations = relations(aiFeedback, ({ one }) => ({
  tenant: one(tenants, {
    fields: [aiFeedback.tenantId],
    references: [tenants.id],
  }),
  summary: one(aiSummaries, {
    fields: [aiFeedback.summaryId],
    references: [aiSummaries.id],
  }),
}));

export type AiFeedback = typeof aiFeedback.$inferSelect;
export type NewAiFeedback = typeof aiFeedback.$inferInsert;
