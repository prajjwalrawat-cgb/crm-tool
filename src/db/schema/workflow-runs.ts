import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

export const WORKFLOW_STATUSES = [
  'running',
  'completed',
  'failed',
  'skipped',
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/**
 * One row per Inngest function run we care to surface in the admin UI.
 * The Inngest dashboard remains the source of truth for raw step traces;
 * this table is our portable, tenant-scoped projection of "what happened
 * when, on which tenant, with what outcome".
 *
 * `inngest_run_id` is the run id Inngest assigns to the function execution
 * so you can deep-link from our admin to theirs.
 *
 * `metadata` carries shape per workflow (e.g. `{ dealId, dealName, from, to }`
 * for `deal-won`). The renderer treats this as opaque jsonb.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Stable workflow identifier — same as the Inngest function id. */
    workflowId: text('workflow_id').notNull(),
    /** Inngest event that triggered the run (e.g. `deal.stage_changed`). */
    eventName: text('event_name'),
    /** Inngest's run uuid; blank when we couldn't capture it. */
    inngestRunId: text('inngest_run_id'),
    status: text('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [
    index('workflow_runs_tenant_started_idx').on(t.tenantId, t.startedAt),
    index('workflow_runs_inngest_idx').on(t.inngestRunId),
  ],
);

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  tenant: one(tenants, {
    fields: [workflowRuns.tenantId],
    references: [tenants.id],
  }),
}));

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
