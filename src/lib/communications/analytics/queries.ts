import 'server-only';

import { and, eq, gte, sql } from 'drizzle-orm';

import {
  communicationAnalytics,
  type CommunicationMetric,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Read N days of a single metric. Returns an array oldest-first so
 * chart libraries can render without re-sorting. Days with no row
 * are NOT zero-filled here — the dashboard component decides whether
 * gaps mean "no data" or "render zero".
 */
export async function readMetricTrend(
  tenantId: string,
  metric: CommunicationMetric,
  windowDays: number,
): Promise<Array<{ day: string; value: number }>> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        day: communicationAnalytics.metricDay,
        value: communicationAnalytics.metricValue,
      })
      .from(communicationAnalytics)
      .where(
        and(
          eq(communicationAnalytics.tenantId, tenantId),
          eq(communicationAnalytics.metricName, metric),
          gte(communicationAnalytics.metricDay, cutoff),
        ),
      )
      .orderBy(sql`${communicationAnalytics.metricDay} ASC`),
  );
  return rows.map((r) => ({ day: r.day, value: Number(r.value) }));
}

/**
 * Latest snapshot of every metric for the dashboard tiles. One row
 * per metric_name, picking the most-recent day. Used by the inbox
 * header "delivery rate today" pill.
 */
export async function latestMetricSnapshot(
  tenantId: string,
): Promise<Record<string, number>> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT DISTINCT ON (metric_name)
        metric_name, metric_value::float8 AS metric_value
      FROM communication_analytics
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY metric_name, metric_day DESC
    `),
  )) as unknown as Array<{ metric_name: string; metric_value: number }>;
  return Object.fromEntries(rows.map((r) => [r.metric_name, Number(r.metric_value)]));
}
