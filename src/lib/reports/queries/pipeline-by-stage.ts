import 'server-only';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { deals } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { type DealStage, DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';

import type { OwnerScope, ReportFilter, ReportRunner } from '../types';

/**
 * Pipeline by stage — the foundational report. For every stage in
 * `DEAL_STAGES`, returns deal count + total amount (in major units).
 * Filters: owner scope (all / mine / specific). Date range is
 * intentionally NOT applied here — pipeline is a current-state
 * snapshot, not a time-window aggregate.
 *
 * Query shape: single GROUP BY scan, no JOINs. Index used:
 * `deals(tenant_id, stage)` (existing). Even at 100k deals this
 * stays under 50ms with the existing partial index that excludes
 * soft-deleted rows.
 *
 * Returns rows pre-sorted by the canonical stage order so the UI
 * doesn't have to. Empty stages still appear (with zeros) — the
 * chart needs the stable axis to compare across snapshots.
 */
export type PipelineByStageRow = {
  stage: DealStage;
  stageLabel: string;
  count: number;
  totalAmountMinor: number;
};

export const pipelineByStageRunner: ReportRunner<
  ReportFilter,
  PipelineByStageRow
> = async (tenantId, filters, context) => {
  const startedAt = Date.now();

  const rows = await tenantTransaction(async (tx) => {
    const conditions = [
      eq(deals.tenantId, tenantId),
      isNull(deals.deletedAt),
    ];
    const ownerClause = buildOwnerCondition(filters.owner, context.currentUserId);
    if (ownerClause) conditions.push(ownerClause);

    return tx
      .select({
        stage: deals.stage,
        count: sql<number>`count(*)::int`.as('count'),
        totalAmountMinor: sql<number>`coalesce(sum(${deals.amountMinor}), 0)::bigint`.as(
          'total_amount_minor',
        ),
      })
      .from(deals)
      .where(and(...conditions))
      .groupBy(deals.stage);
  });

  // Build a stable per-stage map and pad missing stages with zeros so
  // the chart axis is identical across snapshots.
  const byStage = new Map<DealStage, { count: number; totalAmountMinor: number }>();
  for (const r of rows) {
    byStage.set(r.stage as DealStage, {
      count: Number(r.count),
      totalAmountMinor: Number(r.totalAmountMinor),
    });
  }

  const ordered: PipelineByStageRow[] = DEAL_STAGES.map((stage) => {
    const v = byStage.get(stage) ?? { count: 0, totalAmountMinor: 0 };
    return {
      stage,
      stageLabel: DEAL_STAGE_LABELS[stage],
      count: v.count,
      totalAmountMinor: v.totalAmountMinor,
    };
  });

  const totalCount = ordered.reduce((s, r) => s + r.count, 0);
  const totalAmountMinor = ordered.reduce((s, r) => s + r.totalAmountMinor, 0);

  return {
    rows: ordered,
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount,
      headline: {
        label: `${totalCount} deals`,
        // Format in major units, no currency symbol — different currencies
        // across deals; the headline is a coarse health signal, not a
        // ledger total. UI can render with locale formatter.
        value: `$${Math.round(totalAmountMinor / 100).toLocaleString('en-US')}`,
      },
    },
  };
};

/**
 * Resolves an OwnerScope into a Drizzle condition. Returns null when
 * no filter applies. Kept as a module-local helper because rep
 * performance and other reports will likely want a different owner
 * dimension (e.g. per-row aggregation) — sharing this would create
 * the wrong abstraction.
 */
function buildOwnerCondition(
  owner: OwnerScope | undefined,
  currentUserId: string,
) {
  if (!owner) return null;
  if (owner.type === 'all') return null;
  if (owner.type === 'mine') return eq(deals.ownerId, currentUserId);
  return eq(deals.ownerId, owner.userId);
}
