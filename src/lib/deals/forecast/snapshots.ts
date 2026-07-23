import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { forecastSnapshots } from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';

import {
  BEST_CASE_CATEGORIES,
  COMMIT_CATEGORIES,
  type ForecastCategory,
} from './categories';
import type { ForecastRollup } from './rollup';

/**
 * Persist a weekly forecast snapshot for a period (Module 4). Writes one
 * team-total row per category (owner_id NULL) + one per (owner, category) cell,
 * plus an 'overdue' team row — so week-over-week movement can be charted and a
 * "vs last week" delta rendered. Append-only.
 */
export async function captureForecastSnapshot(
  tenantId: string,
  period: string,
  rollup: ForecastRollup,
  exec?: DbExecutor,
): Promise<number> {
  const values: (typeof forecastSnapshots.$inferInsert)[] = [];

  // Team totals per category (owner NULL).
  for (const [category, cell] of Object.entries(rollup.categoryTotals)) {
    if (cell.count === 0) continue;
    values.push({
      tenantId,
      period,
      ownerId: null,
      category,
      totalAmount: cell.amountMinor,
      dealCount: cell.count,
    });
  }
  // Overdue team row.
  if (rollup.overdue.count > 0) {
    values.push({
      tenantId,
      period,
      ownerId: null,
      category: 'overdue',
      totalAmount: rollup.overdue.amountMinor,
      dealCount: rollup.overdue.count,
    });
  }
  // Per-owner, per-category cells.
  for (const owner of rollup.owners) {
    for (const [category, cell] of Object.entries(owner.cells)) {
      if (cell.count === 0) continue;
      values.push({
        tenantId,
        period,
        ownerId: owner.ownerId,
        category,
        totalAmount: cell.amountMinor,
        dealCount: cell.count,
      });
    }
  }

  if (values.length === 0) return 0;
  const write = (tx: DbExecutor) => tx.insert(forecastSnapshots).values(values);
  if (exec) await write(exec);
  else await tenantTransaction(write);
  return values.length;
}

export type ForecastDelta = {
  capturedAt: Date;
  commitMinor: number;
  bestCaseMinor: number;
};

/**
 * The most recent snapshot's Commit / Best-case team totals for a period, used
 * to render the "vs last week" delta against the live numbers. Returns null when
 * no snapshot exists yet (fewer than one weekly capture).
 */
export async function getLatestSnapshotSummary(
  tenantId: string,
  period: string,
): Promise<ForecastDelta | null> {
  return tenantTransaction(async (tx) => {
    // Newest captured_at batch for this period.
    const [latest] = await tx
      .select({ capturedAt: forecastSnapshots.capturedAt })
      .from(forecastSnapshots)
      .where(
        and(
          eq(forecastSnapshots.tenantId, tenantId),
          eq(forecastSnapshots.period, period),
        ),
      )
      .orderBy(desc(forecastSnapshots.capturedAt))
      .limit(1);
    if (!latest) return null;

    const rows = await tx
      .select({
        category: forecastSnapshots.category,
        amt: sql<string>`coalesce(sum(${forecastSnapshots.totalAmount}),0)::bigint`,
      })
      .from(forecastSnapshots)
      .where(
        and(
          eq(forecastSnapshots.tenantId, tenantId),
          eq(forecastSnapshots.period, period),
          eq(forecastSnapshots.capturedAt, latest.capturedAt),
          sql`${forecastSnapshots.ownerId} IS NULL`,
          inArray(
            forecastSnapshots.category,
            BEST_CASE_CATEGORIES as ForecastCategory[],
          ),
        ),
      )
      .groupBy(forecastSnapshots.category);

    const byCat = new Map(rows.map((r) => [r.category, Number(r.amt ?? 0)]));
    const sum = (cats: readonly ForecastCategory[]) =>
      cats.reduce((s, c) => s + (byCat.get(c) ?? 0), 0);

    return {
      capturedAt: latest.capturedAt,
      commitMinor: sum(COMMIT_CATEGORIES),
      bestCaseMinor: sum(BEST_CASE_CATEGORIES),
    };
  });
}
