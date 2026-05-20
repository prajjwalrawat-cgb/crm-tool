import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-entity relationship-health counters. UPSERTed by the send
 * pipeline (synchronous bumps in the same tx as the outbound message
 * write) and refreshed by a nightly Inngest job (rolling-window
 * aggregates).
 *
 * v1 scope: schema lands now; the derivation job + UI card surface
 * in CP#16C-C Phase B. The send pipeline integration will start
 * writing real counters in the same Phase B push.
 */
export const RELATIONSHIP_STATUSES = [
  'healthy',
  'warming',
  'stale',
  'at_risk',
] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

export const relationshipSignals = pgTable(
  'relationship_signals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    totalInbound: integer('total_inbound').notNull().default(0),
    totalOutbound: integer('total_outbound').notNull().default(0),
    unansweredCount: integer('unanswered_count').notNull().default(0),
    avgResponseHours: real('avg_response_hours'),
    silentDays: integer('silent_days').notNull().default(0),
    score: real('score'),
    status: text('status').notNull().default('warming'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('relationship_signals_entity_unique').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
    index('relationship_signals_status_idx').on(
      t.tenantId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const relationshipSignalsRelations = relations(
  relationshipSignals,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [relationshipSignals.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type RelationshipSignal = typeof relationshipSignals.$inferSelect;
export type NewRelationshipSignal = typeof relationshipSignals.$inferInsert;
