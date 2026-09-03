import 'server-only';

import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { deals, salesTargets, type SalesTarget } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { listTeammates } from '@/lib/teammates/queries';

import { fiscalYearRange } from './fiscal';
import {
  QUOTA_CREDIT_APPROVAL_STATUSES,
  QUOTA_WITHHELD_APPROVAL_STATUSES,
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
  /** Quota-credited revenue: face value x deals.quota_weight (R7). */
  revenueAchievedMinor: number;
  marginAchievedMinor: number;
  wonCount: number;
  /** Won revenue in-window held back by the approval gate. */
  pendingApprovalMinor: number;
  pendingApprovalCount: number;
  /**
   * Revenue removed by the pushback haircut (face value - weighted value),
   * and how many deals carry one. Reported rather than silently absorbed so a
   * rep can see WHY their attainment is short of the won total on the same
   * screen — the same contract `pendingApprovalMinor` has:
   *
   *     revenueAchieved + deweightedLoss === face value of credited won deals
   */
  deweightedLossMinor: number;
  deweightedCount: number;
};

/**
 * Achieved revenue + margin per owner from won deals whose close date
 * falls in the fiscal-year window and which earn quota credit — see
 * `./quota-credit` for the rule and why `= 'approved'` was wrong.
 * Margin value is amount × margin% (basis points), in minor units.
 *
 * TWO haircuts apply, and they are deliberately different in kind:
 *   * APPROVAL decides whether a won deal counts at all. Withheld deals are
 *     counted separately rather than dropped, so a rep looking at "₹0
 *     achieved" can tell "you closed nothing" from "your manager hasn't
 *     clicked yet".
 *   * QUOTA WEIGHT (R6/R7) decides how much a counted deal is worth. A deal
 *     pushed more than three times counts at 50%. Both the credited figure
 *     and the amount the weighting removed come back, for the same reason.
 *
 * Revenue is weighted; MARGIN IS NOT. Margin attainment measures the quality
 * of what was sold, and halving it would conflate "this deal was low-margin"
 * with "this deal was late" — two different conversations. The de-weight is a
 * revenue-credit penalty, which is what the comp plan reads.
 */
export async function targetAchievement(
  tenantId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<TargetAchievement[]> {
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  // Both aggregates scan the same won-deals-in-window set; FILTER
  // splits it so credited and withheld revenue come back in one pass
  // and are guaranteed to sum to the period's total won revenue.
  const credits = inArray(deals.approvalStatus, [
    ...QUOTA_CREDIT_APPROVAL_STATUSES,
  ]);
  const withheld = inArray(deals.approvalStatus, [
    ...QUOTA_WITHHELD_APPROVAL_STATUSES,
  ]);
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        userId: deals.ownerId,
        // R7 — credited revenue is amount x quota_weight, never the raw
        // amount. quota_weight is 1.00 for every deal that hasn't been
        // chronically pushed, so this is identity for a healthy pipeline.
        revenueAchievedMinor: sql<string>`COALESCE(SUM(ROUND(${deals.amountMinor} * ${deals.quotaWeight})) FILTER (WHERE ${credits}), 0)`,
        marginAchievedMinor: sql<string>`COALESCE(ROUND(SUM(${deals.amountMinor}::numeric * COALESCE(${deals.marginBps}, 0) / 10000) FILTER (WHERE ${credits})), 0)`,
        wonCount: sql<string>`COUNT(*) FILTER (WHERE ${credits})`,
        pendingApprovalMinor: sql<string>`COALESCE(SUM(${deals.amountMinor}) FILTER (WHERE ${withheld}), 0)`,
        pendingApprovalCount: sql<string>`COUNT(*) FILTER (WHERE ${withheld})`,
        // The gap the weighting opened, over the SAME credited set — so
        // credited + loss reconciles to face value, not to some other cohort.
        deweightedLossMinor: sql<string>`COALESCE(SUM(${deals.amountMinor} - ROUND(${deals.amountMinor} * ${deals.quotaWeight})) FILTER (WHERE ${credits}), 0)`,
        deweightedCount: sql<string>`COUNT(*) FILTER (WHERE ${credits} AND ${deals.quotaWeight} < 1.00)`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.stage, 'won'),
          isNotNull(deals.ownerId),
          isNull(deals.deletedAt),
          gte(deals.closedAt, start),
          lt(deals.closedAt, end),
        ),
      )
      .groupBy(deals.ownerId),
  );

  return rows
    .filter((r): r is typeof r & { userId: string } => r.userId != null)
    .map((r) => ({
      userId: r.userId,
      revenueAchievedMinor: Number(r.revenueAchievedMinor) || 0,
      marginAchievedMinor: Number(r.marginAchievedMinor) || 0,
      wonCount: Number(r.wonCount) || 0,
      pendingApprovalMinor: Number(r.pendingApprovalMinor) || 0,
      pendingApprovalCount: Number(r.pendingApprovalCount) || 0,
      deweightedLossMinor: Number(r.deweightedLossMinor) || 0,
      deweightedCount: Number(r.deweightedCount) || 0,
    }));
}

export type TargetProgressRow = {
  userId: string;
  displayName: string;
  role: string | null;
  revenueTargetMinor: number;
  revenueAchievedMinor: number;
  marginTargetMinor: number;
  marginAchievedMinor: number;
  wonCount: number;
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
        revenueAchievedMinor: ach?.revenueAchievedMinor ?? 0,
        marginTargetMinor: target?.marginTargetMinor ?? 0,
        marginAchievedMinor: ach?.marginAchievedMinor ?? 0,
        wonCount: ach?.wonCount ?? 0,
        pendingApprovalMinor: ach?.pendingApprovalMinor ?? 0,
        pendingApprovalCount: ach?.pendingApprovalCount ?? 0,
        deweightedLossMinor: ach?.deweightedLossMinor ?? 0,
        deweightedCount: ach?.deweightedCount ?? 0,
      };
    });

  // Highest revenue target first, then biggest achievers.
  rows.sort(
    (a, b) =>
      b.revenueTargetMinor - a.revenueTargetMinor ||
      b.revenueAchievedMinor - a.revenueAchievedMinor,
  );
  return rows;
}
