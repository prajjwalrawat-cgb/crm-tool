import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Append-only event ledger that feeds the agent learning loop. Every
 * server action that mutates CRM state emits one row here as a
 * side effect. The pattern derivation jobs scan this table; the
 * recommendation runners never read from it directly.
 *
 * Why a separate table from `activity_logs`:
 *   - activity_logs is user-facing audit (who did what, when).
 *   - agent_observations is machine-facing signal (what outcomes
 *     correlate with what behaviors).
 * Keeping them separate avoids polluting the activity feed with
 * derived/scoring metadata and lets the observation schema evolve
 * (outcome_score is the obvious one) without touching the audit log.
 *
 * Append-only contract enforced in app code — there's no UPDATE
 * helper. Mistakes are corrected by writing a compensating row, not
 * mutating history.
 */
export const agentObservations = pgTable(
  'agent_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Clerk user id of the actor. NULL for system-emitted observations. */
    actorUserId: text('actor_user_id'),
    observationType: text('observation_type').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    metadata: jsonb('metadata').notNull().default({}),
    /**
     * Reserved RL signal in [-1, 1]. v1 only fills it on terminal
     * events: +1 on deal won, -1 on deal lost, smaller magnitudes
     * for partial signals. Most rows leave it NULL.
     */
    outcomeScore: real('outcome_score'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('agent_observations_type_idx').on(
      t.tenantId,
      t.observationType,
      t.createdAt,
    ),
    index('agent_observations_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
    index('agent_observations_actor_idx').on(
      t.tenantId,
      t.actorUserId,
      t.createdAt,
    ),
  ],
);

export const agentObservationsRelations = relations(
  agentObservations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [agentObservations.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type AgentObservation = typeof agentObservations.$inferSelect;
export type NewAgentObservation = typeof agentObservations.$inferInsert;
