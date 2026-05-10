import { relations } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Cache of AI-generated summaries per (tenant, entity). One row per
 * entity — generating again overwrites. `sourceHash` lets the
 * regeneration workflow skip work when the source data hasn't changed.
 */
export const aiSummaries = pgTable(
  'ai_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    summary: text('summary').notNull(),
    model: text('model').notNull(),
    sourceHash: text('source_hash').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_summaries_tenant_entity_unique').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
  ],
);

export const aiSummariesRelations = relations(aiSummaries, ({ one }) => ({
  tenant: one(tenants, {
    fields: [aiSummaries.tenantId],
    references: [tenants.id],
  }),
}));

export type AiSummary = typeof aiSummaries.$inferSelect;
export type NewAiSummary = typeof aiSummaries.$inferInsert;
