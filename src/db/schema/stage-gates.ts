import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { dealStage } from './enums';
import { tenants } from './tenants';

/**
 * Admin-defined per-stage entry requirements — the saleinx equivalent of
 * Salesforce Path + validation rules. `stage` is the stage being ENTERED; a
 * deal cannot advance into it until every active `block` rule passes.
 *
 * One row per (tenant, stage, rule_type). `rule_config` shape depends on
 * `rule_type` (see `src/lib/stage-gates/types.ts`). Evaluation is entirely
 * server-side in `evaluateStageTransition`; the client only renders results.
 */
export const stageGates = pgTable(
  'stage_gates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The stage being entered that this rule guards. */
    stage: dealStage('stage').notNull(),
    /**
     * One of: field_required | min_stakeholders | min_activities |
     * amount_required | task_complete | custom_note. DB CHECK-constrained in
     * migration 0049.
     */
    ruleType: text('rule_type').notNull(),
    /** Rule-type-specific configuration (fields list, counts, thresholds…). */
    ruleConfig: jsonb('rule_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** 'block' rejects the transition; 'warn' allows it but logs a gate_warning. */
    severity: text('severity').notNull().default('block'),
    isActive: boolean('is_active').notNull().default(true),
    /** User id (text, matches deals.ownerId convention) of the admin who created it. */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('stage_gates_tenant_stage_rule_uniq').on(
      t.tenantId,
      t.stage,
      t.ruleType,
    ),
    index('stage_gates_tenant_stage_active_idx').on(
      t.tenantId,
      t.stage,
      t.isActive,
    ),
  ],
);

export const stageGatesRelations = relations(stageGates, ({ one }) => ({
  tenant: one(tenants, {
    fields: [stageGates.tenantId],
    references: [tenants.id],
  }),
}));

export type StageGate = typeof stageGates.$inferSelect;
export type NewStageGate = typeof stageGates.$inferInsert;
