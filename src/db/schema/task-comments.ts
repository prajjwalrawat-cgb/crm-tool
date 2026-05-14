import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tasks } from './tasks';
import { tenants } from './tenants';

/**
 * Per-task discussion thread. Flat (no nesting) and no mention parsing
 * in v1 — the schema in `comments` covers the heavy collaboration case.
 * Task comments are scoped tightly to one task, deleted automatically
 * when the parent task is hard-deleted.
 */
export const taskComments = pgTable(
  'task_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Clerk user id of the author. */
    authorUserId: text('author_user_id').notNull(),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('task_comments_tenant_task_idx').on(
      t.tenantId,
      t.taskId,
      t.createdAt,
    ),
    index('task_comments_tenant_author_idx').on(t.tenantId, t.authorUserId),
  ],
);

export const taskCommentsRelations = relations(taskComments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [taskComments.tenantId],
    references: [tenants.id],
  }),
  task: one(tasks, {
    fields: [taskComments.taskId],
    references: [tasks.id],
  }),
}));

export type TaskComment = typeof taskComments.$inferSelect;
export type NewTaskComment = typeof taskComments.$inferInsert;
