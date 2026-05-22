import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Chart Views — per-user (or shared) chart customization persistence.
 * Backs the hidden "Chart Studio" surface (Cmd/Ctrl+K on a focused
 * chart). The `config` column is jsonb so the studio can evolve
 * without schema migrations — each chart_key declares its own config
 * shape client-side; the server stores it opaquely.
 *
 * roleScope:
 *   'user'   → personal view, visible only to the saving user
 *   'team'   → shared across manager+admin
 *   'tenant' → org-wide, admin-only to write
 *
 * The (tenant_id, user_id, chart_key) tuple is NOT a hard unique
 * constraint — a user can save multiple named views for the same
 * chart. The default-view uniqueness is enforced at the DB layer by
 * a partial unique index `WHERE is_default = true`.
 */
export const chartViews = pgTable(
  'chart_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    chartKey: text('chart_key').notNull(),
    title: text('title'),
    roleScope: text('role_scope').notNull().default('user'),
    config: jsonb('config').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('chart_views_tenant_user_chart_idx').on(
      t.tenantId,
      t.userId,
      t.chartKey,
    ),
  ],
);

export type ChartView = typeof chartViews.$inferSelect;
export type NewChartView = typeof chartViews.$inferInsert;
