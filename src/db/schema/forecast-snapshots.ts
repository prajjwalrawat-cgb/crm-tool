import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Weekly forecast snapshots (Module 4). One row per (tenant, period, owner,
 * category) captured by the Monday-morning cron, so week-over-week movement of
 * the forecast can be charted and a "vs last week" delta rendered. Append-only.
 *
 * `ownerId` NULL = the team-total row for that (period, category). `period` is
 * a label like '2026-Q3' (quarter) or '2026-07' (month).
 */
export const forecastSnapshots = pgTable(
  'forecast_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    ownerId: text('owner_id'),
    category: text('category').notNull(),
    /** Summed amount in minor units (workspace currency). */
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull().default(0),
    dealCount: integer('deal_count').notNull().default(0),
    capturedAt: timestamp('captured_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('forecast_snapshots_tenant_period_idx').on(
      t.tenantId,
      t.period,
      t.capturedAt,
    ),
  ],
);

export const forecastSnapshotsRelations = relations(
  forecastSnapshots,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [forecastSnapshots.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type ForecastSnapshot = typeof forecastSnapshots.$inferSelect;
export type NewForecastSnapshot = typeof forecastSnapshots.$inferInsert;
