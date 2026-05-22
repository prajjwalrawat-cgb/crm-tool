import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { chartViews } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import {
  type ChartKey,
  parseRevenueTrendConfig,
  type SavedChartView,
} from './config';

/**
 * Read the user's default view for a chart. Falls back to null when
 * there isn't one — the caller renders the chart's hard-coded default
 * config in that case.
 *
 * RLS: runs inside the active tenant context, so the tenant filter
 * here is belt-and-suspenders on top of `app.tenant_id`.
 */
export async function readDefaultChartView(args: {
  tenantId: string;
  userId: string;
  chartKey: ChartKey;
}): Promise<SavedChartView | null> {
  const row = await tenantTransaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(chartViews)
      .where(
        and(
          eq(chartViews.tenantId, args.tenantId),
          eq(chartViews.userId, args.userId),
          eq(chartViews.chartKey, args.chartKey),
          eq(chartViews.isDefault, true),
        ),
      )
      .orderBy(desc(chartViews.updatedAt))
      .limit(1);
    return r ?? null;
  });

  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    roleScope: (row.roleScope as 'user' | 'team' | 'tenant') ?? 'user',
    config: parseRevenueTrendConfig(row.config),
    isDefault: row.isDefault,
  };
}
