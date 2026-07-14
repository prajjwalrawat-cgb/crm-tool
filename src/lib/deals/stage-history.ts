import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { dealStageHistory, type DealStage } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type StageHistoryEntry = {
  stage: DealStage;
  enteredAt: Date;
  exitedAt: Date | null;
  /** Whole days spent (or spent so far, if current) in this stage. */
  durationDays: number;
  isCurrent: boolean;
};

export type DealStageHistoryResult = {
  entries: StageHistoryEntry[];
  currentStage: DealStage | null;
  currentDurationDays: number | null;
  /** Tenant-wide average days-in-stage for closed intervals, per stage. */
  avgByStage: Partial<Record<DealStage, number>>;
  /**
   * True when the deal has sat in its current stage longer than the tenant's
   * historical average for that stage — the "this deal is stalling" flag.
   */
  currentExceedsAvg: boolean;
  /**
   * Why (if at all) the current stage should be flagged as stalling:
   *   'exceeds-average' — beyond the tenant's historical avg for this stage
   *   'long-in-stage'   — no average exists yet, but the deal has been in an
   *                       active stage past an absolute threshold
   *   null              — not stalling
   */
  staleReason: 'exceeds-average' | 'long-in-stage' | null;
};

/**
 * Non-terminal stages we still expect deals to move out of. Won/Lost are
 * terminal, so "days in stage" there isn't a stall signal.
 */
const ACTIVE_STAGES: ReadonlySet<DealStage> = new Set<DealStage>([
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'hold',
]);

/**
 * Absolute "this has sat too long" threshold used only when the tenant has no
 * historical average for the stage yet (e.g. right after the feature ships).
 * Once real closed intervals exist, the comparative average takes over.
 */
const ABSOLUTE_STALE_DAYS = 30;

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Load a deal's stage-occupancy timeline plus the tenant-wide average time in
 * each stage. Both come straight from `deal_stage_history` — no separate
 * service, just the trigger-maintained table and one aggregate query.
 */
export async function getDealStageHistory(
  tenantId: string,
  dealId: string,
): Promise<DealStageHistoryResult> {
  return await tenantTransaction(async (tx) => {
    const [rows, avgRows] = await Promise.all([
      tx
        .select({
          stage: dealStageHistory.stage,
          enteredAt: dealStageHistory.enteredAt,
          exitedAt: dealStageHistory.exitedAt,
        })
        .from(dealStageHistory)
        .where(
          and(
            eq(dealStageHistory.tenantId, tenantId),
            eq(dealStageHistory.dealId, dealId),
          ),
        )
        .orderBy(asc(dealStageHistory.enteredAt)),
      tx.execute(sql`
        SELECT stage::text AS stage,
               AVG(EXTRACT(EPOCH FROM (exited_at - entered_at)) / 86400.0) AS avg_days
        FROM deal_stage_history
        WHERE tenant_id = ${tenantId}::uuid
          AND exited_at IS NOT NULL
        GROUP BY stage
      `) as unknown as Array<{ stage: string; avg_days: number | string }>,
    ]);

    const now = new Date();
    const entries: StageHistoryEntry[] = rows.map((r) => {
      const isCurrent = r.exitedAt === null;
      const end = r.exitedAt ?? now;
      return {
        stage: r.stage,
        enteredAt: r.enteredAt,
        exitedAt: r.exitedAt,
        durationDays: daysBetween(r.enteredAt, end),
        isCurrent,
      };
    });

    const avgByStage: Partial<Record<DealStage, number>> = {};
    for (const a of avgRows) {
      const v = typeof a.avg_days === 'string' ? Number(a.avg_days) : a.avg_days;
      if (Number.isFinite(v)) avgByStage[a.stage as DealStage] = v;
    }

    const current = entries.find((e) => e.isCurrent) ?? null;
    const currentStage = current?.stage ?? null;
    const currentDurationDays = current?.durationDays ?? null;
    const avgForCurrent = currentStage ? avgByStage[currentStage] : undefined;
    const currentExceedsAvg =
      current != null &&
      avgForCurrent != null &&
      avgForCurrent > 0 &&
      current.durationDays > avgForCurrent;

    // Decide the stall signal: prefer the comparative average; fall back to an
    // absolute threshold when no average exists yet (and the stage is active).
    let staleReason: DealStageHistoryResult['staleReason'] = null;
    if (currentExceedsAvg) {
      staleReason = 'exceeds-average';
    } else if (
      current != null &&
      currentStage != null &&
      avgForCurrent == null &&
      ACTIVE_STAGES.has(currentStage) &&
      current.durationDays > ABSOLUTE_STALE_DAYS
    ) {
      staleReason = 'long-in-stage';
    }

    return {
      entries,
      currentStage,
      currentDurationDays,
      avgByStage,
      currentExceedsAvg,
      staleReason,
    };
  });
}
