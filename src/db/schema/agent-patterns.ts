import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Derived knowledge. UPSERTed by scheduled derivation jobs; the app
 * never writes here from a server action. `pattern_key` is a stable
 * hash of the dimensions the pattern correlates so re-running the
 * derivation overwrites the old finding in place.
 *
 * `pattern_data jsonb` is intentionally shape-open. v1 holds SQL-
 * aggregated stats; a future model swap (ML recommender, bandit) can
 * write its own shape without a migration. Consumers parse the
 * `pattern_type`-specific kind they expect.
 *
 * `learned_from_range` carries the observation window the derivation
 * used. Lets the recommendation runner decide whether to trust a
 * stale finding (e.g. ignore patterns derived from > 60 days ago).
 */
export const agentPatterns = pgTable(
  'agent_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(),
    patternKey: text('pattern_key').notNull(),
    confidenceScore: real('confidence_score').notNull().default(0),
    supportingSampleSize: integer('supporting_sample_size')
      .notNull()
      .default(0),
    patternData: jsonb('pattern_data').notNull().default({}),
    learnedFromRange: jsonb('learned_from_range').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('agent_patterns_unique').on(
      t.tenantId,
      t.patternType,
      t.patternKey,
    ),
    index('agent_patterns_type_idx').on(
      t.tenantId,
      t.patternType,
      t.updatedAt,
    ),
  ],
);

export const agentPatternsRelations = relations(agentPatterns, ({ one }) => ({
  tenant: one(tenants, {
    fields: [agentPatterns.tenantId],
    references: [tenants.id],
  }),
}));

export type AgentPattern = typeof agentPatterns.$inferSelect;
export type NewAgentPattern = typeof agentPatterns.$inferInsert;
