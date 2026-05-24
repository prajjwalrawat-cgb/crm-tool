import 'server-only';

import { and, desc, eq } from 'drizzle-orm';

import { chartViews } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import {
  CHART_KEY_REVENUE_TREND,
  CHART_KEY_STAGE_CONVERSION,
  CHART_KEY_STAGE_DONUT,
  parseRevenueTrendConfig,
  parseStageConversionConfig,
  parseStageDonutConfig,
  type ChartKey,
  type RevenueTrendConfig,
  type StageConversionConfig,
  type StageDonutConfig,
} from './config';

/**
 * Per-chart saved-view readers. Each chart key has its own typed
 * config parser; the helpers return null when no row exists so the
 * caller can fall back to the chart's hard-coded default.
 *
 * RLS: each helper runs inside the active tenant context. The tenant
 * filter is belt-and-suspenders on top of `app.tenant_id`.
 */

async function readRow(args: {
  tenantId: string;
  userId: string;
  chartKey: ChartKey;
}): Promise<{
  id: string;
  title: string | null;
  roleScope: 'user' | 'team' | 'tenant';
  rawConfig: unknown;
  isDefault: boolean;
} | null> {
  return await tenantTransaction(async (tx) => {
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
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      roleScope: (r.roleScope as 'user' | 'team' | 'tenant') ?? 'user',
      rawConfig: r.config,
      isDefault: r.isDefault,
    };
  });
}

export async function readRevenueTrendView(args: {
  tenantId: string;
  userId: string;
}): Promise<{
  title: string | null;
  config: RevenueTrendConfig;
} | null> {
  const row = await readRow({ ...args, chartKey: CHART_KEY_REVENUE_TREND });
  if (!row) return null;
  return { title: row.title, config: parseRevenueTrendConfig(row.rawConfig) };
}

export async function readStageConversionView(args: {
  tenantId: string;
  userId: string;
}): Promise<{
  title: string | null;
  config: StageConversionConfig;
} | null> {
  const row = await readRow({ ...args, chartKey: CHART_KEY_STAGE_CONVERSION });
  if (!row) return null;
  return { title: row.title, config: parseStageConversionConfig(row.rawConfig) };
}

export async function readStageDonutView(args: {
  tenantId: string;
  userId: string;
}): Promise<{
  title: string | null;
  config: StageDonutConfig;
} | null> {
  const row = await readRow({ ...args, chartKey: CHART_KEY_STAGE_DONUT });
  if (!row) return null;
  return { title: row.title, config: parseStageDonutConfig(row.rawConfig) };
}

// Back-compat shim used by the three home dashboards before the
// multi-chart refactor. Routes to the revenue-trend reader. Keep
// until callers are migrated.
export async function readDefaultChartView(args: {
  tenantId: string;
  userId: string;
  chartKey: ChartKey;
}): Promise<{
  id: string;
  title: string | null;
  roleScope: 'user' | 'team' | 'tenant';
  config: RevenueTrendConfig;
  isDefault: boolean;
} | null> {
  const row = await readRow(args);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    roleScope: row.roleScope,
    config: parseRevenueTrendConfig(row.rawConfig),
    isDefault: row.isDefault,
  };
}
