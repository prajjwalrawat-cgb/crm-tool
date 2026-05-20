import 'server-only';

import { sql } from 'drizzle-orm';

import { formatTenantCurrency } from '@/lib/currency/format';
import { tenantTransaction } from '@/lib/db-context';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { listTeammates, type Teammate } from '@/lib/teammates/queries';

import { resolveDateRange } from '../filters';
import type { ReportFilter, ReportRunner } from '../types';

/**
 * Rep Performance — per-owner leaderboard across closed deals and
 * activity signals. One row per owner who recorded any signal in the
 * window. Each metric comes from its own CTE so a zero in one column
 * is just `COALESCE(NULL, 0)`, not a join that drops the row.
 *
 * Date window applies to:
 *   - wins/losses → `deals.closed_at`
 *   - activities  → `activity_logs.created_at`
 *   - emails      → `email_messages.created_at`
 *   - tasks done  → `tasks.completed_at`
 *
 * Owner names + avatars are resolved in a single Clerk fetch via
 * `listTeammates` — never per-row. The leaderboard sorts by revenue
 * desc; reps with zero revenue still appear if they have other signal.
 */
export type RepPerformanceRow = {
  ownerId: string;
  ownerDisplayName: string;
  ownerEmail: string | null;
  ownerImageUrl: string | null;
  wonCount: number;
  lostCount: number;
  revenueMinor: number;
  avgWonAmountMinor: number;
  winRate: number;            // 0-1 ratio; null when no closed deals
  activityCount: number;
  emailCount: number;
  tasksCompleted: number;
};

export type RepPerformanceExtras = {
  windowFrom: string;
  windowTo: string;
  totalRevenueMinor: number;
  totalClosed: number;
};

export const repPerformanceRunner: ReportRunner<
  ReportFilter,
  RepPerformanceRow,
  RepPerformanceExtras
> = async (tenantId, filters, _context) => {
  const startedAt = Date.now();
  const range = resolveDateRange(filters.range ?? 'last_90d', 'last_90d');
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  type RawRow = {
    ownerId: string;
    wonCount: string;
    lostCount: string;
    wonRevenue: string;
    avgWonAmount: string;
    activityCount: string;
    emailCount: string;
    tasksCompleted: string;
  };

  // One query, five aggregate CTEs, full-outer-join via UNION of owner
  // ids in `all_owners`. Single round-trip; runtime dominated by the
  // largest CTE (usually `activities` on a busy tenant).
  const raw = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      WITH wins AS (
        SELECT owner_id,
               count(*)::int                              AS won_count,
               coalesce(sum(amount_minor), 0)::bigint     AS won_revenue,
               coalesce(avg(amount_minor), 0)::bigint     AS avg_won_amount
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          AND stage = 'won'
          AND closed_at >= ${fromIso}::timestamptz
          AND closed_at <  ${toIso}::timestamptz
          AND owner_id IS NOT NULL
        GROUP BY owner_id
      ),
      losses AS (
        SELECT owner_id, count(*)::int AS lost_count
        FROM deals
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          AND stage = 'lost'
          AND closed_at >= ${fromIso}::timestamptz
          AND closed_at <  ${toIso}::timestamptz
          AND owner_id IS NOT NULL
        GROUP BY owner_id
      ),
      acts AS (
        SELECT actor_user_id AS owner_id, count(*)::int AS activity_count
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND actor_user_id IS NOT NULL
          AND created_at >= ${fromIso}::timestamptz
          AND created_at <  ${toIso}::timestamptz
        GROUP BY actor_user_id
      ),
      emails AS (
        SELECT actor_user_id AS owner_id, count(*)::int AS email_count
        FROM email_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND status IN ('sent','delivered')
          AND created_at >= ${fromIso}::timestamptz
          AND created_at <  ${toIso}::timestamptz
        GROUP BY actor_user_id
      ),
      tasks_done AS (
        SELECT assigned_user_id AS owner_id, count(*)::int AS tasks_completed
        FROM tasks
        WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          AND status = 'completed'
          AND completed_at >= ${fromIso}::timestamptz
          AND completed_at <  ${toIso}::timestamptz
          AND assigned_user_id IS NOT NULL
        GROUP BY assigned_user_id
      ),
      all_owners AS (
        SELECT owner_id FROM wins
        UNION SELECT owner_id FROM losses
        UNION SELECT owner_id FROM acts
        UNION SELECT owner_id FROM emails
        UNION SELECT owner_id FROM tasks_done
      )
      SELECT
        o.owner_id                          AS "ownerId",
        coalesce(w.won_count, 0)            AS "wonCount",
        coalesce(l.lost_count, 0)           AS "lostCount",
        coalesce(w.won_revenue, 0)          AS "wonRevenue",
        coalesce(w.avg_won_amount, 0)       AS "avgWonAmount",
        coalesce(a.activity_count, 0)       AS "activityCount",
        coalesce(e.email_count, 0)          AS "emailCount",
        coalesce(t.tasks_completed, 0)      AS "tasksCompleted"
      FROM all_owners o
      LEFT JOIN wins        w ON w.owner_id = o.owner_id
      LEFT JOIN losses      l ON l.owner_id = o.owner_id
      LEFT JOIN acts        a ON a.owner_id = o.owner_id
      LEFT JOIN emails      e ON e.owner_id = o.owner_id
      LEFT JOIN tasks_done  t ON t.owner_id = o.owner_id
    `),
  )) as unknown as RawRow[];

  // Resolve owner display names via Clerk in a single fetch.
  const teammates = await safeListTeammates(tenantId);
  const byId = new Map(teammates.map((t) => [t.id, t]));

  const rows: RepPerformanceRow[] = raw.map((r) => {
    const wonCount = Number(r.wonCount);
    const lostCount = Number(r.lostCount);
    const totalClosed = wonCount + lostCount;
    const t = byId.get(r.ownerId) ?? null;
    return {
      ownerId: r.ownerId,
      ownerDisplayName: t?.displayName ?? fallbackDisplayName(r.ownerId),
      ownerEmail: t?.email ?? null,
      ownerImageUrl: t?.imageUrl ?? null,
      wonCount,
      lostCount,
      revenueMinor: Number(r.wonRevenue),
      avgWonAmountMinor: Number(r.avgWonAmount),
      winRate: totalClosed === 0 ? 0 : wonCount / totalClosed,
      activityCount: Number(r.activityCount),
      emailCount: Number(r.emailCount),
      tasksCompleted: Number(r.tasksCompleted),
    };
  });

  // Sort by revenue desc; ties broken by activity count.
  rows.sort((a, b) => {
    if (b.revenueMinor !== a.revenueMinor) {
      return b.revenueMinor - a.revenueMinor;
    }
    return b.activityCount - a.activityCount;
  });

  const totalRevenueMinor = rows.reduce((s, r) => s + r.revenueMinor, 0);
  const totalClosed = rows.reduce((s, r) => s + r.wonCount + r.lostCount, 0);

  return {
    rows,
    extras: {
      windowFrom: range.from.toISOString(),
      windowTo: range.to.toISOString(),
      totalRevenueMinor,
      totalClosed,
    },
    meta: {
      generatedAt: new Date().toISOString(),
      queryMs: Date.now() - startedAt,
      totalCount: rows.length,
      headline: {
        label: `${rows.length} reps`,
        value: formatTenantCurrency(
          totalRevenueMinor,
          await getOrgSettings(tenantId),
        ),
      },
    },
  };
};

/**
 * Wrap Clerk's teammate fetch so a Clerk hiccup never breaks the
 * report. We can still render rows with fallback names if the lookup
 * fails — the leaderboard table just loses avatars + display names.
 */
async function safeListTeammates(
  tenantId: string,
): Promise<Teammate[]> {
  try {
    // listTeammates requires the tenant *name* in this codebase for
    // user-friendly fallback rendering. The runner doesn't have it,
    // so pass an empty string — listTeammates only uses it for
    // display fallback when Clerk returns no users.
    return await listTeammates(tenantId, '');
  } catch {
    return [];
  }
}

function fallbackDisplayName(userId: string): string {
  // Trim Clerk's `user_…` prefix for a cleaner fallback than the raw id.
  if (userId.startsWith('user_')) {
    return userId.slice(0, 12) + '…';
  }
  return userId.slice(0, 16);
}
