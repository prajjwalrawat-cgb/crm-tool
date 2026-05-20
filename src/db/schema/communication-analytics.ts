import { relations } from 'drizzle-orm';
import {
  index,
  numeric,
  pgTable,
  text,
  date,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants';

/**
 * Daily-rolled-up analytics keyed by (tenant, day, metric_name). The
 * dashboard renders trend lines by reading this table; the events
 * ledger is the source of truth, this is the cache.
 *
 * `metric_name` is open-ended (`sent_count`, `engagement_score`,
 * `avg_response_seconds`, …) so adding a metric is a code change,
 * not a schema change. The nightly Inngest job (CP#16C-E) UPSERTs.
 */
export const communicationAnalytics = pgTable(
  'communication_analytics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    metricDay: date('metric_day').notNull(),
    metricName: text('metric_name').notNull(),
    metricValue: numeric('metric_value', { precision: 18, scale: 6 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('communication_analytics_unique').on(
      t.tenantId,
      t.metricDay,
      t.metricName,
    ),
    index('communication_analytics_trend_idx').on(
      t.tenantId,
      t.metricName,
      t.metricDay,
    ),
  ],
);

export const communicationAnalyticsRelations = relations(
  communicationAnalytics,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [communicationAnalytics.tenantId],
      references: [tenants.id],
    }),
  }),
);

export type CommunicationAnalytic =
  typeof communicationAnalytics.$inferSelect;
export type NewCommunicationAnalytic =
  typeof communicationAnalytics.$inferInsert;

/**
 * Canonical metric names — keep the call sites typed even though the
 * DB column is free-text. New metric? Add a literal here and the
 * dashboard knows about it; the DB UPSERT path doesn't need to change.
 */
export const COMMUNICATION_METRICS = [
  'sent_count',
  'delivered_count',
  'failed_count',
  'retry_count',
  'opened_count',
  'clicked_count',
  'replied_count',
  'bounced_count',
  'success_rate',
  'bounce_rate',
  'engagement_score',
] as const;
export type CommunicationMetric = (typeof COMMUNICATION_METRICS)[number];
