import 'server-only';

import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import { deals } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { resolveDateRange } from '../filters';
import type { OwnerScope, ReportFilter, ReportRunner } from '../types';

/**
 * Win/Loss Rate — closed-deal performance over a time window. Returns
 * one row per terminal stage (won, lost) with count + revenue. The
 * runner also computes derived fields (winRate, totalClosed) used by
 * the chart and the headline tile.
 *
 * Date window applies to `closed_at`, not `created_at` — a deal that
 * opened a year ago and closed this quarter counts toward this quarter's
 * win rate. Default range: last 90 days.
 *
 * The partial index `deals_tenant_stage_closed_at_idx` (added in
 * 0014_report_indexes.sql) covers the WHERE clause directly so this
 * stays an index-only scan even at 100k deals.
 */
export type WinLossRateRow = {
  stage: 'won' | 'lost';
  count: number;
  revenueMinor: number;
};

export type WinLossRateExtras = {
  winRate: number;            // 0-1 ratio
  totalClosed: number;
  totalRevenueMinor: number;
  windowFrom: string;          // ISO
  windowTo: string;            // ISO
};

export const winLossRateRunner: ReportRunner<
  ReportFilter,
  WinLossRateRow,
  WinLossRateExtras
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();
  const range = resolveDateRange(filters.range ?? 'last_90d', 'last_90d');

  const rows = await tenantTransaction(async (tx) => {
    const conditions = [
      eq(deals.tenantId, tenantId),
      isNull(deals.deletedAt),
      inArray(deals.stage, ['won', 'lost']),
      gte(deals.closedAt, range.from),
      lt(deals.closedAt, range.to),
    ];
    const ownerClause = buildOwnerCondition(filters.owner, context.currentUserId);
    if (ownerClause) conditions.push(ownerClause);

    return tx
      .select({
        stage: deals.stage,
        count: sql<number>`count(*)::int`,
        revenueMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`,
      })
      .from(deals)
      .where(and(...conditions))
      .groupBy(deals.stage);
  });

  // Pad both rows so the chart always has two bars even at zero.
  const byStage = new Map<'won' | 'lost', WinLossRateRow>();
  for (const r of rows) {
    byStage.set(r.stage as 'won' | 'lost', {
      stage: r.stage as 'won' | 'lost',
      count: Number(r.count),
      revenueMinor: Number(r.revenueMinor),
    });
  }
  const ordered: WinLossRateRow[] = [
    byStage.get('won') ?? { stage: 'won', count: 0, revenueMinor: 0 },
    byStage.get('lost') ?? { stage: 'lost', count: 0, revenueMinor: 0 },
  ];

  const won = ordered[0]!.count;
  const lost = ordered[1]!.count;
  const totalClosed = won + lost;
  const winRate = totalClosed === 0 ? 0 : won / totalClosed;
  const totalRevenueMinor = ordered.reduce((s, r) => s + r.revenueMinor, 0);

  return {
    rows: ordered,
    extras: {
      winRate,
      totalClosed,
      totalRevenueMinor,
      windowFrom: range.from.toISOString(),
      windowTo: range.to.toISOString(),
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: totalClosed,
      headline: {
        label: `${totalClosed} closed`,
        value:
          totalClosed === 0
            ? '—'
            : `${Math.round(winRate * 100)}% win rate`,
      },
    },
  };
};

function buildOwnerCondition(
  owner: OwnerScope | undefined,
  currentUserId: string,
) {
  if (!owner) return null;
  if (owner.type === 'all') return null;
  if (owner.type === 'mine') return eq(deals.ownerId, currentUserId);
  return eq(deals.ownerId, owner.userId);
}
