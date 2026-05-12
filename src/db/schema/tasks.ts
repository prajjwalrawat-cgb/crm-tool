import { relations } from 'drizzle-orm';
import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { taskPriority, taskStatus } from './enums';
import { tenants } from './tenants';

/**
 * Operational tasks attached to the CRM. A task can stand alone or be
 * polymorphically linked to a deal / company / contact via
 * (entity_type, entity_id). Linking is loose by design — entities are
 * soft-deleted, so we don't enforce a hard FK; the activity feed and
 * detail pages re-resolve the entity at render time and gracefully
 * handle "the linked record was deleted" cases.
 *
 * `assigned_user_id` and `created_by` are Clerk user ids (text — Clerk
 * issues `user_…` and we tolerate the seed-actor prefix used by the
 * Test 1 fixture).
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: taskStatus('status').notNull().default('todo'),
    priority: taskPriority('priority').notNull().default('medium'),
    dueDate: date('due_date'),
    /** Clerk user id of the assignee. Null = unassigned. */
    assignedUserId: text('assigned_user_id'),
    /** Clerk user id of the creator. */
    createdBy: text('created_by').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Polymorphic link: 'deal' | 'company' | 'contact' | null. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
  },
  (t) => [
    index('tasks_tenant_status_idx').on(t.tenantId, t.status),
    index('tasks_tenant_assigned_idx').on(t.tenantId, t.assignedUserId),
    index('tasks_tenant_due_idx').on(t.tenantId, t.dueDate),
    index('tasks_tenant_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    index('tasks_tenant_deleted_idx').on(t.tenantId, t.deletedAt),
  ],
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, {
    fields: [tasks.tenantId],
    references: [tenants.id],
  }),
}));

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
