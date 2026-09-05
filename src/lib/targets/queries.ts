import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { salesTargets, type SalesTarget } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { listTeammates } from '@/lib/teammates/queries';

import { fiscalYearRange } from './fiscal';
import {
  splitPortionBeforeSql,
  splitPortionInWindowSql,
  toISODate,
} from './fy-attribution';
import {
  DEWEIGHTED_LOSS_SQL,
  DEWEIGHTED_SQL,
  QUOTA_CREDIT_SQL,
  QUOTA_WITHHELD_SQL,
  WEIGHTED_AMOUNT_SQL,
} from './quota-credit';

/** All targets set for a tenant in a given fiscal year. */
export async function listTargets(
  tenantId: string,
  fiscalYear: number,
): Promise<SalesTarget[]> {
  return await db
    .select()
    .from(salesTargets)
    .where(
      and(
        eq(salesTargets.tenantId, tenantId),
        eq(salesTargets.fiscalYear, fiscalYear),
      ),
    );
}

export type TargetAchievement = {
  userId: string;
  /**
   * TOTAL CONTRACT VALUE won in the fiscal year: face value x
   * `deals.quota_weight` (R7), credited whole to the year the deal closed
   * in. This is what the team SOLD, and it is NOT what attainment is
   * measured against — see `fyRevenueMinor`.
   */
  tcvWonMinor: number;
  /**
   * The portion of that TCV attributable to this fiscal year, prorated by
   * date overlap across `deal_value_splits` (see `./fy-attribution`).
   * THIS is the numerator of the achievement percentage.
   *
   * For a deal with no breakdown it equals the deal's whole weighted TCV —
   * the single-year assumption, counted in `splitlessCount`.
   */
  fyRevenueMinor: number;
  /** TCV won this year whose revenue lands in a LATER fiscal year. */
  futurePeriodMinor: number;
  /** TCV won this year whose revenue belonged to an EARLIER one. Usually 0. */
  priorPeriodMinor: number;
  /**
   * Margin value on the TCV won — `amount x margin_bps`, unweighted and
   * NOT prorated. See the note on `targetAchievement` for why.
   */
  marginAchievedMinor: number;
  wonCount: number;
  /** Credited won deals that carry a breakdown, and those that don't. */
  splitCount: number;
  splitlessCount: number;
  /** Credited won deals with a recorded margin, and those without. */
  marginKnownCount: number;
  marginMissingCount: number;
  /** Won revenue in-window held back by the approval gate. */
  pendingApprovalMinor: number;
  pendingApprovalCount: number;
  /**
   * Revenue removed by the pushback haircut (face value - weighted value),
   * and how many deals carry one. Reported rather than silently absorbed so a
   * rep can see WHY their attainment is short of the won total on the same
   * screen — the same contract `pendingApprovalMinor` has:
   *
   *     tcvWon + deweightedLoss === face value of credited won deals
   */
  deweightedLossMinor: number;
  deweightedCount: number;
};

type AchievementRow = {
  user_id: string | null;
  tcv_won: string | number;
  fy_revenue: string | number;
  prior_revenue: string | number;
  margin_value: string | number;
  won_count: string | number;
  split_count: string | number;
  splitless_count: string | number;
  margin_known_count: string | number;
  margin_missing_count: string | number;
  pending_amount: string | number;
  pending_count: string | number;
  deweighted_loss: string | number;
  deweighted_count: string | number;
};

/**
 * Per-owner achievement for a fiscal year, over won deals that earn quota
 * credit — see `./quota-credit` for the credit rule and why `= 'approved'`
 * was wrong.
 *
 * TWO NUMBERS, NOT ONE. `tcvWonMinor` is the total contract value closed in
 * the year; `fyRevenueMinor` is the slice of it that belongs to the year.
 * They were the same number until this query learned to read
 * `deal_value_splits`, and conflating them is what made a rep carrying
 * ₹3.09 Cr of multi-year contracts read as 77% of a ₹4 Cr annual target when
 * the year's own revenue was 63% of it. Both come back so the card can show
 * the gap rather than pick a side.
 *
 * THREE haircuts apply, deliberately different in kind:
 *   * APPROVAL decides whether a won deal counts at all. Withheld deals are
 *     counted separately rather than dropped, so a rep looking at "₹0
 *     achieved" can tell "you closed nothing" from "your manager hasn't
 *     clicked yet".
 *   * QUOTA WEIGHT (R6/R7) decides how much a counted deal is worth. A deal
 *     pushed more than three times counts at 50%. Both the credited figure
 *     and the amount the weighting removed come back, for the same reason.
 *   * FISCAL ATTRIBUTION decides how much of a counted deal lands in THIS
 *     year. The remainder is returned as `futurePeriodMinor` rather than
 *     vanishing, so `fyRevenue + future + prior === tcvWon` and a manager
 *     can see where the rest of the contract went.
 *
 * MARGIN IS NEITHER WEIGHTED NOR PRORATED, and both omissions are on
 * purpose:
 *   * Weighting is a revenue-credit penalty, which is what the comp plan
 *     reads. Halving margin would conflate "this deal was low-margin" with
 *     "this deal was late" — two different conversations.
 *   * Proration is not applied because margin is a property of the contract
 *     as sold, and changing its basis would move a number compensation may
 *     depend on. The margin bar is therefore labelled as being on TCV won,
 *     so the two bars can't be misread as measuring the same window.
 *
 * `margin_bps` NULL still contributes zero to the sum — deliberately
 * unchanged, because inventing a margin for a historical deal would be
 * worse than reporting the gap. What IS new is `marginMissingCount`, so the
 * UI can say the figure covers 2 of 22 deals instead of implying 22.
 *
 * Rounding is per-deal on every money column, matching what
 * `deweightedLossMinor` already promised: credited + loss reconciles to face
 * value deal by deal, not only in aggregate.
 */
export async function targetAchievement(
  tenantId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<TargetAchievement[]> {
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  const fyStartISO = toISODate(start);
  const fyEndISO = toISODate(end);

  const credited = sql.raw(QUOTA_CREDIT_SQL);
  const withheld = sql.raw(QUOTA_WITHHELD_SQL);

  // A LATERAL rather than a GROUP BY join: it always yields exactly one row
  // per deal (aggregates over an empty set), so `has_split` comes back false
  // for a deal with no breakdown instead of the row disappearing.
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH won AS (
        SELECT
          id, owner_id, amount_minor, quota_weight, margin_bps,
          (${credited}) AS credited,
          (${withheld}) AS withheld
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid
          AND stage = 'won'
          AND owner_id IS NOT NULL
          AND deleted_at IS NULL
          AND closed_at >= ${start.toISOString()}::timestamptz
          AND closed_at <  ${end.toISOString()}::timestamptz
      ),
      attributed AS (
        SELECT
          w.*,
          sp.has_split,
          -- No breakdown => single-year assumption, i.e. the old behaviour.
          -- Counted in splitless_count so the card can disclose it.
          CASE WHEN sp.has_split THEN sp.in_fy ELSE w.amount_minor::numeric END
            AS in_fy_raw,
          CASE WHEN sp.has_split THEN sp.before_fy ELSE 0::numeric END
            AS before_fy_raw
        FROM won w
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) > 0 AS has_split,
            ${splitPortionInWindowSql(fyStartISO, fyEndISO)} AS in_fy,
            ${splitPortionBeforeSql(fyStartISO)} AS before_fy
          FROM deal_value_splits s
          WHERE s.deal_id = w.id
        ) sp ON TRUE
      )
      SELECT
        owner_id AS user_id,
        COALESCE(SUM(${sql.raw(WEIGHTED_AMOUNT_SQL)}) FILTER (WHERE credited), 0)::bigint
          AS tcv_won,
        COALESCE(SUM(ROUND(in_fy_raw * quota_weight)) FILTER (WHERE credited), 0)::bigint
          AS fy_revenue,
        COALESCE(SUM(ROUND(before_fy_raw * quota_weight)) FILTER (WHERE credited), 0)::bigint
          AS prior_revenue,
        COALESCE(
          ROUND(SUM(amount_minor::numeric * COALESCE(margin_bps, 0) / 10000)
                FILTER (WHERE credited)),
          0
        )::bigint AS margin_value,
        COUNT(*) FILTER (WHERE credited)::int AS won_count,
        COUNT(*) FILTER (WHERE credited AND has_split)::int AS split_count,
        COUNT(*) FILTER (WHERE credited AND NOT has_split)::int AS splitless_count,
        COUNT(*) FILTER (WHERE credited AND margin_bps IS NOT NULL)::int
          AS margin_known_count,
        COUNT(*) FILTER (WHERE credited AND margin_bps IS NULL)::int
          AS margin_missing_count,
        COALESCE(SUM(amount_minor) FILTER (WHERE withheld), 0)::bigint AS pending_amount,
        COUNT(*) FILTER (WHERE withheld)::int AS pending_count,
        COALESCE(SUM(${sql.raw(DEWEIGHTED_LOSS_SQL)}) FILTER (WHERE credited), 0)::bigint
          AS deweighted_loss,
        COUNT(*) FILTER (WHERE credited AND ${sql.raw(DEWEIGHTED_SQL)})::int
          AS deweighted_count
      FROM attributed
      GROUP BY owner_id
    `),
  )) as unknown as AchievementRow[];

  return rows
    .filter((r): r is AchievementRow & { user_id: string } => r.user_id != null)
    .map((r) => {
      const tcvWonMinor = Number(r.tcv_won) || 0;
      const fyRevenueMinor = Number(r.fy_revenue) || 0;
      const priorPeriodMinor = Number(r.prior_revenue) || 0;
      return {
        userId: r.user_id,
        tcvWonMinor,
        fyRevenueMinor,
        priorPeriodMinor,
        // Derived, not summed: the three buckets then reconcile to TCV
        // exactly, absorbing the sub-unit drift of three independent
        // per-deal roundings into the bucket that tolerates it. Floored at
        // 0 so that drift can never render as a negative "future" figure.
        futurePeriodMinor: Math.max(
          0,
          tcvWonMinor - fyRevenueMinor - priorPeriodMinor,
        ),
        marginAchievedMinor: Number(r.margin_value) || 0,
        wonCount: Number(r.won_count) || 0,
        splitCount: Number(r.split_count) || 0,
        splitlessCount: Number(r.splitless_count) || 0,
        marginKnownCount: Number(r.margin_known_count) || 0,
        marginMissingCount: Number(r.margin_missing_count) || 0,
        pendingApprovalMinor: Number(r.pending_amount) || 0,
        pendingApprovalCount: Number(r.pending_count) || 0,
        deweightedLossMinor: Number(r.deweighted_loss) || 0,
        deweightedCount: Number(r.deweighted_count) || 0,
      };
    });
}

export type TargetProgressRow = {
  userId: string;
  displayName: string;
  role: string | null;
  revenueTargetMinor: number;
  /** Attainment numerator: this year's slice of the contracts won. */
  fyRevenueMinor: number;
  /** Total contract value won — reported alongside, never as attainment. */
  tcvWonMinor: number;
  futurePeriodMinor: number;
  priorPeriodMinor: number;
  marginTargetMinor: number;
  marginAchievedMinor: number;
  wonCount: number;
  /** Won deals counted at full TCV because they carry no breakdown. */
  splitlessCount: number;
  /** Won deals whose margin was never recorded. */
  marginMissingCount: number;
  /** Won revenue held back by the approval gate — shown as a footnote. */
  pendingApprovalMinor: number;
  pendingApprovalCount: number;
  /** Revenue removed by the pushback haircut — shown as a second footnote. */
  deweightedLossMinor: number;
  deweightedCount: number;
};

/**
 * Merge targets + achievement into one row per member for the progress view.
 * Includes every teammate with a sales persona (so a member with a target but
 * no wins yet still appears at 0%). `onlyUserId` scopes to a single rep.
 */
export async function getTargetProgress(
  tenantId: string,
  tenantName: string,
  fiscalYear: number,
  startMonth: number,
  opts: { onlyUserId?: string } = {},
): Promise<TargetProgressRow[]> {
  const [targets, achievement, teammates] = await Promise.all([
    listTargets(tenantId, fiscalYear),
    targetAchievement(tenantId, fiscalYear, startMonth),
    listTeammates(tenantId, tenantName),
  ]);

  const targetByUser = new Map(targets.map((t) => [t.userId, t]));
  const achByUser = new Map(achievement.map((a) => [a.userId, a]));

  const rows: TargetProgressRow[] = teammates
    .filter((t) => (opts.onlyUserId ? t.id === opts.onlyUserId : true))
    // Sales-facing personas own deals; owners/admins set targets rather than
    // carry them. Keep anyone who has a target or recorded achievement, plus
    // managers and members.
    .filter(
      (t) =>
        t.role === 'manager' ||
        t.role === 'member' ||
        t.role === 'viewer' ||
        targetByUser.has(t.id) ||
        achByUser.has(t.id),
    )
    .map((t) => {
      const target = targetByUser.get(t.id);
      const ach = achByUser.get(t.id);
      return {
        userId: t.id,
        displayName: t.displayName,
        role: t.role,
        revenueTargetMinor: target?.revenueTargetMinor ?? 0,
        fyRevenueMinor: ach?.fyRevenueMinor ?? 0,
        tcvWonMinor: ach?.tcvWonMinor ?? 0,
        futurePeriodMinor: ach?.futurePeriodMinor ?? 0,
        priorPeriodMinor: ach?.priorPeriodMinor ?? 0,
        marginTargetMinor: target?.marginTargetMinor ?? 0,
        marginAchievedMinor: ach?.marginAchievedMinor ?? 0,
        wonCount: ach?.wonCount ?? 0,
        splitlessCount: ach?.splitlessCount ?? 0,
        marginMissingCount: ach?.marginMissingCount ?? 0,
        pendingApprovalMinor: ach?.pendingApprovalMinor ?? 0,
        pendingApprovalCount: ach?.pendingApprovalCount ?? 0,
        deweightedLossMinor: ach?.deweightedLossMinor ?? 0,
        deweightedCount: ach?.deweightedCount ?? 0,
      };
    });

  // Highest revenue target first, then biggest achievers. Ranked on the
  // fiscal-year figure, since that is the one the page is about.
  rows.sort(
    (a, b) =>
      b.revenueTargetMinor - a.revenueTargetMinor ||
      b.fyRevenueMinor - a.fyRevenueMinor,
  );
  return rows;
}
