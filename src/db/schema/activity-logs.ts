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

export const ACTIVITY_ENTITY_TYPES = [
  'company',
  'contact',
  'deal',
  'membership',
  'invitation',
  'task',
  'note',
  'email',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export const ACTIVITY_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'restored',
  'stage_changed',
  'invited',
  'invitation_revoked',
  'member_removed',
  'role_changed',
  /**
   * System-driven activity entry produced by an Inngest workflow. The row's
   * `actor_user_id` is null (sentinel `system`) and `metadata.message` carries
   * the human-readable text. Used for things like "Deal Acme Corp marked won
   * — schedule a follow-up reminder for May 15".
   */
  'automation_note',
  /** Task lifecycle: status transitioned to completed. */
  'task_completed',
  /** Owner changed on an entity (currently used for deal owner). */
  'owner_changed',
  /** Email sent from the CRM (acted on the linked entity). */
  'email_sent',
  /** Email send attempt failed. */
  'email_failed',
  /** A manager approved a Won deal (counts toward sales targets). */
  'deal_approved',
  /** A manager rejected a Won deal (reopened to Negotiation). */
  'deal_rejected',
  /** Manually logged phone call (via the deal "Log activity" form). */
  'call_logged',
  /** Manually logged meeting (via the deal "Log activity" form). */
  'meeting_logged',
  /**
   * A `severity: 'warn'` stage gate failed but the transition was allowed
   * anyway (Module 1). `metadata` carries `{ from, to, rules: [...] }` naming
   * each warn rule that did not pass, so the deal timeline records what was
   * skipped without blocking the rep.
   */
  'gate_warning',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const activityLogs = pgTable(
  'activity_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Clerk user id of the actor. Null only for system-generated events. */
    actorUserId: text('actor_user_id'),
    /** Discriminator: company | contact | deal | membership | invitation. */
    entityType: text('entity_type').notNull(),
    /**
     * Mixed-id column. UUID strings for our entities (companies/contacts/deals);
     * Clerk-prefixed strings (`user_…`, `orginv_…`) for memberships/invitations.
     */
    entityId: text('entity_id').notNull(),
    /** Verb. See ACTIVITY_ACTIONS for the canonical set. */
    action: text('action').notNull(),
    /**
     * Free-form context for the UI: prior values for diffs, target user
     * details, reason strings, etc. Always shape-validated by the caller.
     */
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Tenant-wide feed, newest first.
    index('activity_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
    // Per-record timeline.
    index('activity_logs_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
      t.createdAt,
    ),
  ],
);

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [activityLogs.tenantId],
    references: [tenants.id],
  }),
}));

export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
