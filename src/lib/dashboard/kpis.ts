import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import type { StageProbabilities } from '@/lib/deals/stage-probability';
import { timeQuery } from '@/lib/pagination/timing';
import { currentFiscalYear, fiscalYearRange } from '@/lib/targets/fiscal';
import { listTargets } from '@/lib/targets/queries';
import {
  QUOTA_CREDIT_SQL,
  QUOTA_WITHHELD_SQL,
} from '@/lib/targets/quota-credit';

import type { DashboardRange } from './range';

/**
 * The dashboard KPI strip's read model.
 *
 * Every tile carries `value` + `priorValue` so the UI renders one
 * consistent "vs prior period" delta. The prior period is always the
 * immediately preceding window of equal length (`DashboardRange.prior`)
 * — no tile invents its own comparison basis.
 *
 * Flow vs stock:
 *   · Win rate / avg deal size / avg cycle are FLOWS — measured over
 *     the window, compared against the same measure over the prior
 *     window.
 *   · Total + weighted pipeline are STOCKS — there is no such thing as
 *     "pipeline during a period". Their prior value is the pipeline as
 *     it stood at the START of the window (= end of the prior window),
 *     reconstructed from created_at / closed_at / deal_stage_history.
 *     The reconstruction assumes deal amounts don't change
 *     retroactively; a deal whose amount was edited mid-window is
 *     valued at its current amount in both snapshots. Documented
 *     rather than hidden — it's the only honest option without an
 *     amount-history table.
 */

export type KpiPair = {
  value: number;
  priorValue: number;
};

export type DashboardKpis = {
  /** Sum of open (non won/lost) deal amounts, minor units. */
  pipelineMinor: KpiPair;
  /** Σ amount × stage win probability, minor units. */
  weightedPipelineMinor: KpiPair;
  /** won / (won + lost) closed in the window, 0–1. */
  winRate: KpiPair;
  /** Average won-deal amount in the window, minor units. */
  avgWonDealMinor: KpiPair;
  /** Average days from deal creation to won, in the window. */
  avgCycleDays: KpiPair;
  /** Won deal count in the window — drives the avg-deal-size caption. */
  wonCount: KpiPair;
  /** Lost deal count in the window. */
  lostCount: KpiPair;
  /**
   * Null when the org has no revenue target for the current fiscal
   * year (or none for the selected rep). The strip OMITS the tile in
   * that case rather than rendering a zeroed one.
   */
  quota: {
    targetMinor: number;
    achievedMinor: number;
    /** Achieved as of the start of the window — the delta basis. */
    priorAchievedMinor: number;
    /**
     * Won revenue in the same FY window held back by the manager
     * approval gate. `achievedMinor + pendingApprovalMinor` is the
     * total won revenue for the fiscal year, which is what lets the
     * tile reconcile against every other won figure on the page.
     */
    pendingApprovalMinor: number;
    pendingApprovalCount: number;
    fiscalYear: number;
    /** FY window actually measured — drives the tile's scope label. */
    fromISO: string;
    toISO: string;
  } | null;
};

type PipelineSnapshotRow = { stage: string; total: string | number };

/**
 * Open pipeline as it stood at `at`. A deal counts as open then if it
 * existed (`created_at <= at`) and had not yet closed
 * (`closed_at IS NULL OR closed_at > at`). Its stage at that moment
 * comes from `deal_stage_history` (trigger-maintained), falling back
 * to the deal's current stage for rows that pre-date the history
 * table.
 */
async function pipelineSnapshotAt(
  tenantId: string,
  at: Date,
  ownerId: string | null,
  probabilities: StageProbabilities,
): Promise<{ totalMinor: number; weightedMinor: number }> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH open_then AS (
        SELECT
          COALESCE(h.stage::text, d.stage::text) AS stage,
          d.amount_minor
        FROM deals d
        LEFT JOIN LATERAL (
          SELECT sh.stage
          FROM deal_stage_history sh
          WHERE sh.deal_id = d.id
            AND sh.entered_at <= ${at.toISOString()}::timestamptz
            AND (sh.exited_at IS NULL OR sh.exited_at > ${at.toISOString()}::timestamptz)
          ORDER BY sh.entered_at DESC
          LIMIT 1
        ) h ON TRUE
        WHERE d.tenant_id = ${tenantId}::uuid
          AND d.deleted_at IS NULL
          AND d.created_at <= ${at.toISOString()}::timestamptz
          AND (d.closed_at IS NULL OR d.closed_at > ${at.toISOString()}::timestamptz)
          -- owner_id is text (Clerk ids), never uuid — see getStaleDeals.
          AND (${ownerId}::text IS NULL OR d.owner_id = ${ownerId}::text)
      )
      SELECT stage, COALESCE(SUM(amount_minor), 0)::bigint AS total
      FROM open_then
      WHERE stage NOT IN ('won', 'lost')
      GROUP BY stage
    `),
  )) as unknown as PipelineSnapshotRow[];

  let totalMinor = 0;
  let weightedMinor = 0;
  for (const r of rows) {
    const amount = Number(r.total ?? 0);
    totalMinor += amount;
    const prob = probabilities[r.stage as keyof StageProbabilities] ?? 0;
    weightedMinor += (amount * prob) / 100;
  }
  return { totalMinor, weightedMinor: Math.round(weightedMinor) };
}

type ClosedWindowRow = {
  won_count: number;
  lost_count: number;
  won_amount: string | number;
  avg_cycle_days: string | number;
};

/** Won/lost aggregates for deals closed inside [from, to). */
async function closedWindow(
  tenantId: string,
  from: Date,
  to: Date,
  ownerId: string | null,
): Promise<{
  wonCount: number;
  lostCount: number;
  wonAmountMinor: number;
  avgCycleDays: number;
}> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE stage = 'won')::int  AS won_count,
        COUNT(*) FILTER (WHERE stage = 'lost')::int AS lost_count,
        COALESCE(SUM(amount_minor) FILTER (WHERE stage = 'won'), 0)::bigint AS won_amount,
        -- Sales cycle = deal creation → won. created_at is when the
        -- opportunity entered the pipeline (stage defaults to lead), so
        -- this is the lead→won duration without a second table scan.
        COALESCE(
          AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400.0)
            FILTER (WHERE stage = 'won' AND closed_at > created_at),
          0
        )::numeric AS avg_cycle_days
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND stage IN ('won', 'lost')
        AND closed_at IS NOT NULL
        AND closed_at >= ${from.toISOString()}::timestamptz
        AND closed_at <  ${to.toISOString()}::timestamptz
        AND (${ownerId}::text IS NULL OR owner_id = ${ownerId}::text)
    `),
  )) as unknown as ClosedWindowRow[];

  const r = rows[0] ?? {
    won_count: 0,
    lost_count: 0,
    won_amount: 0,
    avg_cycle_days: 0,
  };
  return {
    wonCount: Number(r.won_count) || 0,
    lostCount: Number(r.lost_count) || 0,
    wonAmountMinor: Number(r.won_amount) || 0,
    avgCycleDays: Math.round((Number(r.avg_cycle_days) || 0) * 10) / 10,
  };
}

/**
 * Fiscal-year-to-date won revenue that earns quota credit, split at
 * `splitAt` so the tile can show both the current figure and where it
 * stood when the window opened.
 *
 * Credit rule lives in `lib/targets/quota-credit` and is shared
 * verbatim with `targetAchievement`, so the dashboard tile and the
 * Targets page cannot disagree. The gist: 'none' and 'approved' count,
 * 'pending' and 'rejected' don't. Filtering on `= 'approved'` alone —
 * which is what this did — dropped every deal that never entered the
 * approval workflow, i.e. the default state of the column, i.e. almost
 * all of them.
 *
 * The withheld figure comes back in the same scan so the tile can name
 * the gap instead of leaving the reader to wonder why attainment
 * disagrees with the won total elsewhere on the page.
 */
async function quotaAchievement(
  tenantId: string,
  fyStart: Date,
  now: Date,
  splitAt: Date,
  ownerId: string | null,
): Promise<{
  achievedMinor: number;
  priorAchievedMinor: number;
  pendingApprovalMinor: number;
  pendingApprovalCount: number;
}> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        COALESCE(SUM(amount_minor) FILTER (WHERE ${sql.raw(QUOTA_CREDIT_SQL)}), 0)::bigint
          AS achieved,
        COALESCE(
          SUM(amount_minor) FILTER (
            WHERE ${sql.raw(QUOTA_CREDIT_SQL)}
              AND closed_at < ${splitAt.toISOString()}::timestamptz
          ),
          0
        )::bigint AS prior_achieved,
        COALESCE(SUM(amount_minor) FILTER (WHERE ${sql.raw(QUOTA_WITHHELD_SQL)}), 0)::bigint
          AS pending_amount,
        COUNT(*) FILTER (WHERE ${sql.raw(QUOTA_WITHHELD_SQL)})::int
          AS pending_count
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND stage = 'won'
        AND closed_at IS NOT NULL
        AND closed_at >= ${fyStart.toISOString()}::timestamptz
        AND closed_at <  ${now.toISOString()}::timestamptz
        AND (${ownerId}::text IS NULL OR owner_id = ${ownerId}::text)
    `),
  )) as unknown as Array<{
    achieved: string | number;
    prior_achieved: string | number;
    pending_amount: string | number;
    pending_count: string | number;
  }>;
  const r = rows[0] ?? {
    achieved: 0,
    prior_achieved: 0,
    pending_amount: 0,
    pending_count: 0,
  };
  return {
    achievedMinor: Number(r.achieved) || 0,
    priorAchievedMinor: Number(r.prior_achieved) || 0,
    pendingApprovalMinor: Number(r.pending_amount) || 0,
    pendingApprovalCount: Number(r.pending_count) || 0,
  };
}

export async function getDashboardKpis(
  tenantId: string,
  options: {
    range: DashboardRange;
    ownerId?: string | null;
    probabilities: StageProbabilities;
    fiscalYearStartMonth: number;
  },
): Promise<DashboardKpis> {
  const { range, probabilities, fiscalYearStartMonth } = options;
  const ownerId = options.ownerId ?? null;
  const now = new Date();
  const fiscalYear = currentFiscalYear(fiscalYearStartMonth, now);
  const { start: fyStart } = fiscalYearRange(fiscalYearStartMonth, fiscalYear);

  return await timeQuery('dashboard.kpis', async () => {
    const [
      snapshotNow,
      snapshotThen,
      current,
      prior,
      targets,
      achievement,
    ] = await Promise.all([
      pipelineSnapshotAt(tenantId, now, ownerId, probabilities),
      // Pipeline at the START of the window = end of the prior window.
      pipelineSnapshotAt(tenantId, range.from, ownerId, probabilities),
      closedWindow(tenantId, range.from, range.to, ownerId),
      closedWindow(tenantId, range.prior.from, range.prior.to, ownerId),
      listTargets(tenantId, fiscalYear),
      quotaAchievement(tenantId, fyStart, now, range.from, ownerId),
    ]);

    const rate = (won: number, lost: number) =>
      won + lost > 0 ? won / (won + lost) : 0;
    const avgDeal = (amount: number, count: number) =>
      count > 0 ? Math.round(amount / count) : 0;

    // Scope the quota to the selected rep when one is focused; org-wide
    // otherwise. A zero total means "no target configured" → tile omitted.
    const targetMinor = targets
      .filter((t) => (ownerId ? t.userId === ownerId : true))
      .reduce((s, t) => s + (t.revenueTargetMinor ?? 0), 0);

    return {
      pipelineMinor: {
        value: snapshotNow.totalMinor,
        priorValue: snapshotThen.totalMinor,
      },
      weightedPipelineMinor: {
        value: snapshotNow.weightedMinor,
        priorValue: snapshotThen.weightedMinor,
      },
      winRate: {
        value: rate(current.wonCount, current.lostCount),
        priorValue: rate(prior.wonCount, prior.lostCount),
      },
      avgWonDealMinor: {
        value: avgDeal(current.wonAmountMinor, current.wonCount),
        priorValue: avgDeal(prior.wonAmountMinor, prior.wonCount),
      },
      avgCycleDays: {
        value: current.avgCycleDays,
        priorValue: prior.avgCycleDays,
      },
      wonCount: { value: current.wonCount, priorValue: prior.wonCount },
      lostCount: { value: current.lostCount, priorValue: prior.lostCount },
      quota:
        targetMinor > 0
          ? {
              targetMinor,
              achievedMinor: achievement.achievedMinor,
              priorAchievedMinor: achievement.priorAchievedMinor,
              pendingApprovalMinor: achievement.pendingApprovalMinor,
              pendingApprovalCount: achievement.pendingApprovalCount,
              fiscalYear,
              fromISO: fyStart.toISOString(),
              toISO: now.toISOString(),
            }
          : null,
    };
  });
}
