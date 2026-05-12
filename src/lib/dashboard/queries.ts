import 'server-only';

import { sql } from 'drizzle-orm';

import { tenantTransaction } from '@/lib/db-context';
import type { DealStage } from '@/lib/deals/schema';
import { timeQuery } from '@/lib/pagination/timing';

/**
 * Read model for the dashboard root. Single transaction, four COUNT
 * aggregates that hit only the (tenant_id, deleted_at) and
 * (tenant_id, stage) indexes — no row scans, no joins. Returns the
 * shape the dashboard's KPI strip + pipeline distribution widget
 * expect, so the page-level fetch is one round trip.
 */

export type DashboardOverview = {
  companies: number;
  contacts: number;
  /** Total active deals (excludes won + lost). */
  dealsActive: number;
  /** Per-stage counts including won and lost. */
  dealsByStage: Record<DealStage, number>;
  /**
   * Sum of `amount_minor` for active deals (lead through negotiation).
   * Won/lost are excluded so this represents pipeline still in motion.
   * Mixed-currency tenants will see a single summed scalar — the UI
   * formats it under the tenant's modal currency. Honest tradeoff
   * documented; multi-currency rollup is a separate feature.
   */
  pipelineMinor: number;
  /** Currency code most-frequently used across active deals. Defaults to USD. */
  pipelineCurrency: string;
  /** Won deals closed in the last 30 days. */
  wonRecent: number;
  /** Lost deals closed in the last 30 days. */
  lostRecent: number;
};

const ALL_STAGES: DealStage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
];

export async function getDashboardOverview(
  tenantId: string,
): Promise<DashboardOverview> {
  return await timeQuery('dashboard.overview', async () =>
    tenantTransaction(async (tx) => {
      // Three lightweight totals — companies, contacts, active deals.
      const totalsRows = (await tx.execute(
        sql`SELECT
              (SELECT COUNT(*)::int FROM companies WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS companies,
              (SELECT COUNT(*)::int FROM contacts  WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL) AS contacts,
              (SELECT COUNT(*)::int FROM deals     WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL AND stage NOT IN ('won','lost')) AS deals_active`,
      )) as unknown as Array<{
        companies: number;
        contacts: number;
        deals_active: number;
      }>;
      const totals = totalsRows[0] ?? {
        companies: 0,
        contacts: 0,
        deals_active: 0,
      };

      // Per-stage counts in a single GROUP BY pass.
      const stageRows = (await tx.execute(
        sql`SELECT stage::text AS stage, COUNT(*)::int AS n
            FROM deals
            WHERE tenant_id = ${tenantId}::uuid
              AND deleted_at IS NULL
            GROUP BY stage`,
      )) as unknown as Array<{ stage: string; n: number }>;
      const dealsByStage = ALL_STAGES.reduce(
        (acc, s) => ({ ...acc, [s]: 0 }),
        {} as Record<DealStage, number>,
      );
      for (const row of stageRows) {
        if ((ALL_STAGES as string[]).includes(row.stage)) {
          dealsByStage[row.stage as DealStage] = row.n;
        }
      }

      // Pipeline value: sum across active stages, plus the modal currency
      // for formatting. We pick the most-common currency in the active
      // pipeline; if the tenant truly mixes currencies it will under-
      // represent — flagged in the type doc.
      const pipelineRows = (await tx.execute(
        sql`SELECT currency, SUM(amount_minor)::bigint AS total
            FROM deals
            WHERE tenant_id = ${tenantId}::uuid
              AND deleted_at IS NULL
              AND stage NOT IN ('won','lost')
            GROUP BY currency
            ORDER BY total DESC NULLS LAST`,
      )) as unknown as Array<{ currency: string; total: string | number }>;
      const pipelineCurrency = pipelineRows[0]?.currency ?? 'USD';
      const pipelineMinor = pipelineRows.reduce(
        (sum, r) => sum + Number(r.total ?? 0),
        0,
      );

      // 30-day won / lost — light recency window, single scan.
      const recentRows = (await tx.execute(
        sql`SELECT
              COUNT(*) FILTER (WHERE stage = 'won')::int  AS won,
              COUNT(*) FILTER (WHERE stage = 'lost')::int AS lost
            FROM deals
            WHERE tenant_id = ${tenantId}::uuid
              AND deleted_at IS NULL
              AND closed_at IS NOT NULL
              AND closed_at >= NOW() - INTERVAL '30 days'`,
      )) as unknown as Array<{ won: number; lost: number }>;
      const recent = recentRows[0] ?? { won: 0, lost: 0 };

      return {
        companies: totals.companies,
        contacts: totals.contacts,
        dealsActive: totals.deals_active,
        dealsByStage,
        pipelineMinor,
        pipelineCurrency,
        wonRecent: recent.won,
        lostRecent: recent.lost,
      };
    }),
  );
}

/* ------------------------------------------------------------------
 * Checkpoint #3 — intelligence widgets.
 *
 * Each query targets a single index already on the deals or
 * workflow_runs table. The aggregates here are intentionally
 * coarse-grained (per-day buckets, single counts) so the dashboard
 * stays sub-100ms even on a populated tenant.
 * ------------------------------------------------------------------ */

export type DailyCount = { day: string; n: number };

export type WonLostTrend = {
  days: number;
  won: DailyCount[];
  lost: DailyCount[];
};

/**
 * Daily won / lost counts across the last `days` days. Buckets by
 * `closed_at::date` so deals that closed in the same day collapse to
 * one row. The UI fills missing days with zero, so the SVG sparkline
 * sees a continuous series.
 */
export async function getWonLostTrend(
  tenantId: string,
  days = 30,
): Promise<WonLostTrend> {
  return await timeQuery('dashboard.wonLostTrend', async () =>
    tenantTransaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT closed_at::date AS day, stage::text AS stage, COUNT(*)::int AS n
            FROM deals
            WHERE tenant_id = ${tenantId}::uuid
              AND deleted_at IS NULL
              AND closed_at IS NOT NULL
              AND stage IN ('won','lost')
              AND closed_at >= NOW() - (${days}::int * INTERVAL '1 day')
            GROUP BY closed_at::date, stage
            ORDER BY day ASC`,
      )) as unknown as Array<{ day: string; stage: 'won' | 'lost'; n: number }>;

      return {
        days,
        won: rows
          .filter((r) => r.stage === 'won')
          .map((r) => ({ day: r.day, n: r.n })),
        lost: rows
          .filter((r) => r.stage === 'lost')
          .map((r) => ({ day: r.day, n: r.n })),
      };
    }),
  );
}

/**
 * Daily new-deal counts for the last `days` days. Drives the pipeline
 * trend sparkline above the won/lost chart.
 */
export async function getPipelineCreatedTrend(
  tenantId: string,
  days = 14,
): Promise<DailyCount[]> {
  return await timeQuery('dashboard.pipelineCreatedTrend', async () =>
    tenantTransaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT created_at::date AS day, COUNT(*)::int AS n
            FROM deals
            WHERE tenant_id = ${tenantId}::uuid
              AND deleted_at IS NULL
              AND created_at >= NOW() - (${days}::int * INTERVAL '1 day')
            GROUP BY created_at::date
            ORDER BY day ASC`,
      )) as unknown as Array<{ day: string; n: number }>;
      return rows.map((r) => ({ day: r.day, n: r.n }));
    }),
  );
}

export type StaleDeal = {
  id: string;
  name: string;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  companyName: string | null;
  daysSinceUpdate: number;
};

/**
 * Active deals that haven't moved in `staleDays` or more. Useful for
 * the "needs attention" widget; we exclude won/lost since those are
 * intentionally not progressing.
 */
export async function getStaleDeals(
  tenantId: string,
  options: { staleDays?: number; limit?: number } = {},
): Promise<StaleDeal[]> {
  const staleDays = options.staleDays ?? 14;
  const limit = options.limit ?? 5;
  return await timeQuery('dashboard.staleDeals', async () =>
    tenantTransaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT d.id, d.name, d.stage::text AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency,
                   c.name AS company_name,
                   GREATEST(0, EXTRACT(EPOCH FROM (NOW() - d.updated_at)) / 86400)::int AS days_since_update
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.stage NOT IN ('won','lost')
              AND d.updated_at < NOW() - (${staleDays}::int * INTERVAL '1 day')
            ORDER BY d.updated_at ASC
            LIMIT ${limit}`,
      )) as unknown as Array<{
        id: string;
        name: string;
        stage: DealStage;
        amount_minor: string | number;
        currency: string;
        company_name: string | null;
        days_since_update: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        stage: r.stage,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        companyName: r.company_name,
        daysSinceUpdate: r.days_since_update,
      }));
    }),
  );
}

export type UpcomingFollowUp = {
  id: string;
  name: string;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  companyName: string | null;
  expectedCloseDate: string;
  /** Negative = overdue. */
  daysUntilClose: number;
};

/**
 * Deals with `expected_close_date` either soon (within `lookAheadDays`)
 * or already overdue. Overdue rows sort first because they're the more
 * urgent action item.
 */
export async function getUpcomingFollowUps(
  tenantId: string,
  options: { lookAheadDays?: number; limit?: number } = {},
): Promise<UpcomingFollowUp[]> {
  const lookAheadDays = options.lookAheadDays ?? 14;
  const limit = options.limit ?? 6;
  return await timeQuery('dashboard.upcomingFollowUps', async () =>
    tenantTransaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT d.id, d.name, d.stage::text AS stage,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency,
                   c.name AS company_name,
                   d.expected_close_date,
                   (d.expected_close_date - CURRENT_DATE)::int AS days_until_close
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.stage NOT IN ('won','lost')
              AND d.expected_close_date IS NOT NULL
              AND d.expected_close_date <= CURRENT_DATE + (${lookAheadDays}::int * INTERVAL '1 day')
            ORDER BY d.expected_close_date ASC
            LIMIT ${limit}`,
      )) as unknown as Array<{
        id: string;
        name: string;
        stage: DealStage;
        amount_minor: string | number;
        currency: string;
        company_name: string | null;
        expected_close_date: string;
        days_until_close: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        stage: r.stage,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        companyName: r.company_name,
        expectedCloseDate: r.expected_close_date,
        daysUntilClose: r.days_until_close,
      }));
    }),
  );
}

export type RecentWin = {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  companyName: string | null;
  closedAt: Date;
};

/**
 * Five most-recent won deals — surfaces the "celebration" stream and
 * lets the dashboard show real outcomes, not just funnel counts.
 */
export async function getRecentWins(
  tenantId: string,
  limit = 5,
): Promise<RecentWin[]> {
  return await timeQuery('dashboard.recentWins', async () =>
    tenantTransaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT d.id, d.name,
                   d.amount_minor::bigint AS amount_minor,
                   d.currency,
                   c.name AS company_name,
                   d.closed_at
            FROM deals d
            LEFT JOIN companies c ON c.id = d.company_id
            WHERE d.tenant_id = ${tenantId}::uuid
              AND d.deleted_at IS NULL
              AND d.stage = 'won'
              AND d.closed_at IS NOT NULL
            ORDER BY d.closed_at DESC
            LIMIT ${limit}`,
      )) as unknown as Array<{
        id: string;
        name: string;
        amount_minor: string | number;
        currency: string;
        company_name: string | null;
        closed_at: Date | string;
      }>;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        amountMinor: Number(r.amount_minor),
        currency: r.currency,
        companyName: r.company_name,
        closedAt: new Date(r.closed_at),
      }));
    }),
  );
}

export type WorkflowHealth = {
  /** Counts over the last `days` days. */
  completed: number;
  failed: number;
  skipped: number;
  running: number;
  total: number;
  /** Most-recent successful completion across all workflows (any age). */
  lastSuccessAt: Date | null;
  /** Oldest currently-running run, if any (helps spot stuck jobs). */
  oldestRunningAt: Date | null;
  days: number;
};

/**
 * Aggregate health of workflow_runs over a recent window. Used by the
 * compact "Workflow health" widget — replaces the previous
 * RecentWorkflowsStrip which only listed five rows without context.
 */
export async function getWorkflowHealth(
  tenantId: string,
  days = 7,
): Promise<WorkflowHealth> {
  return await timeQuery('dashboard.workflowHealth', async () =>
    tenantTransaction(async (tx) => {
      const statsRow = (await tx.execute(
        sql`SELECT
              COUNT(*) FILTER (WHERE status = 'completed' AND started_at >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS completed,
              COUNT(*) FILTER (WHERE status = 'failed'    AND started_at >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS failed,
              COUNT(*) FILTER (WHERE status = 'skipped'   AND started_at >= NOW() - (${days}::int * INTERVAL '1 day'))::int AS skipped,
              COUNT(*) FILTER (WHERE status = 'running')::int                                                              AS running,
              MAX(completed_at) FILTER (WHERE status = 'completed')                                                         AS last_success_at,
              MIN(started_at)   FILTER (WHERE status = 'running')                                                           AS oldest_running_at
            FROM workflow_runs
            WHERE tenant_id = ${tenantId}::uuid`,
      )) as unknown as Array<{
        completed: number;
        failed: number;
        skipped: number;
        running: number;
        last_success_at: Date | string | null;
        oldest_running_at: Date | string | null;
      }>;
      const r = statsRow[0] ?? {
        completed: 0,
        failed: 0,
        skipped: 0,
        running: 0,
        last_success_at: null,
        oldest_running_at: null,
      };
      return {
        completed: r.completed,
        failed: r.failed,
        skipped: r.skipped,
        running: r.running,
        total: r.completed + r.failed + r.skipped,
        lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
        oldestRunningAt: r.oldest_running_at
          ? new Date(r.oldest_running_at)
          : null,
        days,
      };
    }),
  );
}
