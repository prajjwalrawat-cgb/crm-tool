import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Per-recipient notification stream. Distinct from `activity_logs` —
 * activity is a tenant-wide audit feed everyone sees; notifications
 * are "things addressed to a specific user that need attention" and
 * are RLS-scoped to the recipient (the `app.user_id` GUC).
 *
 * The dropdown UI reads `recipient_user_id + created_at desc` (covered
 * by `notifications_recipient_idx`) and the unread badge uses the
 * partial index on `read_at IS NULL` for a cheap COUNT(*).
 */
export const NOTIFICATION_TYPES = [
  'task_assigned',
  'task_completed',
  'task_due_soon',
  'deal_won',
  'deal_lost',
  'owner_changed',
  'comment_mention',
  'automation_failed',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Clerk user id of the user this notification is addressed to. */
    recipientUserId: text('recipient_user_id').notNull(),
    /** Clerk user id of whoever triggered it. Null for system events. */
    actorUserId: text('actor_user_id'),
    /** Discriminator — see NOTIFICATION_TYPES. */
    type: text('type').notNull(),
    /** Optional link to a deal / task / contact / company / etc. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** Denormalized so the dropdown renders without a join. */
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    metadata: jsonb('metadata').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('notifications_recipient_idx').on(
      t.tenantId,
      t.recipientUserId,
      t.createdAt,
    ),
    index('notifications_entity_idx').on(
      t.tenantId,
      t.entityType,
      t.entityId,
    ),
    // Partial index for the unread badge is created in the SQL
    // migration directly (Drizzle's index builder doesn't model
    // partial indexes; we get it via the migration file).
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  tenant: one(tenants, {
    fields: [notifications.tenantId],
    references: [tenants.id],
  }),
}));

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
