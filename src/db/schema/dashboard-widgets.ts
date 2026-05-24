import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Dashboard widget instances — per-user, draggable, resizable. Backs
 * the Edit Mode UI (Cmd/Ctrl+Shift+E) where users create / move /
 * resize / delete widgets on a react-grid-layout canvas.
 *
 * `widget_type` is the family (chart, kpi, list, text, leaderboard,
 * ...); `chart_type` + `metric` + `dimension` apply to chart widgets.
 * `config_json` is the per-widget-type settings blob (shape parsed by
 * the matching chart-studio config parser).
 *
 * Built-in dashboard charts (the ones currently composed into Sales /
 * Manager / Admin homes) are NOT modeled here — their customization
 * lives in `chart_views`. This table is exclusively for user-created
 * widget instances.
 */
export const dashboardWidgets = pgTable(
  'dashboard_widgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    widgetType: text('widget_type').notNull(),
    chartType: text('chart_type'),
    metric: text('metric'),
    dimension: text('dimension'),
    layoutX: integer('layout_x').notNull().default(0),
    layoutY: integer('layout_y').notNull().default(0),
    layoutW: integer('layout_w').notNull().default(4),
    layoutH: integer('layout_h').notNull().default(4),
    title: text('title'),
    configJson: jsonb('config_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('dashboard_widgets_tenant_user_idx').on(t.tenantId, t.userId),
  ],
);

export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type NewDashboardWidget = typeof dashboardWidgets.$inferInsert;
