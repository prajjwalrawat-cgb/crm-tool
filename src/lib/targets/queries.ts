import 'server-only';

import { and, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { db } from '@/db';
import { deals, salesTargets, type SalesTarget } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { listTeammates } from '@/lib/teammates/queries';

import { fiscalYearRange } from './fiscal';

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
  revenueAchievedMinor: number;
  marginAchievedMinor: number;
  wonCount: number;
};

/**
 * Achieved revenue + margin per owner from Won AND manager-approved deals
 * whose close date falls in the fiscal-year window. Margin value is
 * amount × margin% (basis points), summed in minor units.
 */
export async function targetAchievement(
  tenantId: string,
  fiscalYear: number,
  startMonth: number,
): Promise<TargetAchievement[]> {
  const { start, end } = fiscalYearRange(startMonth, fiscalYear);
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        userId: deals.ownerId,
        revenueAchievedMinor: sql<string>`COALESCE(SUM(${deals.amountMinor}), 0)`,
        marginAchievedMinor: sql<string>`COALESCE(ROUND(SUM(${deals.amountMinor}::numeric * COALESCE(${deals.marginBps}, 0) / 10000)), 0)`,
        wonCount: sql<string>`COUNT(*)`,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.stage, 'won'),
          eq(deals.approvalStatus, 'approved'),
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
