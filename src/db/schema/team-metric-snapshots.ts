import { relations } from 'drizzle-orm';
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Period-close snapshots of the Team Performance scorecard (migration 0061).
 * One row per (tenant, metric, rep, period); `repId` NULL is the team-wide
 * row, the same convention `forecast_snapshots` uses.
 *
 * `value` holds RAW counters — numerators and denominators, never a derived
 * percentage — so a delta can be recomputed if a definition changes and a
 * moved target can't make a rep look like they went backwards. See the
 * migration's design notes.
 *
 * Written only by `captureTeamMetrics` (the monthly cron and the manual
 * backfill script); read only by `readSnapshotPeriod`.
 */
export const teamMetricSnapshots = pgTable(
  'team_metric_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** One of `TEAM_METRICS` in `@/lib/team-analytics/snapshots`. */
    metric: text('metric').notNull(),
    /** NULL = the team-wide row for this (metric, period). */
    repId: text('rep_id'),
    /** 'YYYY-MM' — the month this value closed. */
    period: text('period').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('team_metric_snapshots_tenant_period_idx').on(t.tenantId, t.period)],
);

export const teamMetricSnapshotsRelations = relations(
  teamMetricSnapshots,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [teamMetricSnapshots.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type TeamMetricSnapshot = typeof teamMetricSnapshots.$inferSelect;
export type NewTeamMetricSnapshot = typeof teamMetricSnapshots.$inferInsert;
