import 'server-only';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  activityLogs,
  dealContacts,
  dealScores,
  dealStageHistory,
  deals,
  tasks,
  workspaceSettings,
  type DealScore,
  type DealStage,
} from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';

import { computeDealScore, type DealScoreContext } from './compute';

/**
 * Fallback per-stage median days-in-stage, used until a stage has ≥10 completed
 * transitions to compute a real median from. Values per the Module 2 spec.
 */
const FALLBACK_MEDIANS: Record<DealStage, number> = {
  lead: 14,
  qualified: 14,
  proposal: 21,
  negotiation: 14,
  hold: 30,
  won: 14,
  lost: 14,
};

/** Stages whose deals are still "open" and get scored. */
const OPEN_STAGES: DealStage[] = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'hold',
];

const GENUINE_ACTIVITY_ACTIONS = ['call_logged', 'meeting_logged', 'email_sent'];
const GENUINE_TASK_TYPES = ['call', 'email', 'meeting'];
const MS_PER_DAY = 86_400_000;

/** Is Module 2 (DEAL_SCORING_ENABLED) on for this tenant? No row = OFF. */
async function scoringEnabled(
  exec: DbExecutor,
  tenantId: string,
): Promise<boolean> {
  const [row] = await exec
    .select({ enabled: workspaceSettings.dealScoringEnabled })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.tenantId, tenantId))
    .limit(1);
  return row?.enabled === true;
}

/**
 * Tenant-wide median days-in-stage from `deal_stage_history` completed
 * intervals, falling back to {@link FALLBACK_MEDIANS} for any stage with fewer
 * than 10 transitions. Computed once per recompute batch and reused.
 */
export async function getWorkspaceStageMedians(
  exec: DbExecutor,
  tenantId: string,
): Promise<Record<DealStage, number>> {
  const rows = (await exec.execute(sql`
    SELECT stage::text AS stage,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (exited_at - entered_at)) / 86400.0
           ) AS median_days,
           count(*) AS n
    FROM deal_stage_history
    WHERE tenant_id = ${tenantId}::uuid AND exited_at IS NOT NULL
    GROUP BY stage
  `)) as unknown as Array<{
    stage: string;
    median_days: number | string | null;
    n: number | string;
  }>;

  const medians: Record<DealStage, number> = { ...FALLBACK_MEDIANS };
  for (const r of rows) {
    const stage = r.stage as DealStage;
    const n = typeof r.n === 'string' ? Number(r.n) : r.n;
    const median =
      typeof r.median_days === 'string' ? Number(r.median_days) : r.median_days;
    if (n >= 10 && median != null && Number.isFinite(median) && median > 0) {
      medians[stage] = median;
    }
  }
  return medians;
}

type DealFields = {
  stage: DealStage;
  expectedCloseDate: string | null;
  nextStep: string | null;
  amountMinor: number;
};

/**
 * Gather the full scoring context for one deal. Returns null when the deal is
 * closed (won/lost) or missing — closed deals are not scored.
 */
async function gatherContext(
  exec: DbExecutor,
  tenantId: string,
  dealId: string,
  deal: DealFields,
  medians: Record<DealStage, number>,
  now: Date,
): Promise<DealScoreContext | null> {
  if (deal.stage === 'won' || deal.stage === 'lost') return null;

  const [act] = await exec
    .select({ last: sql<Date | null>`max(${activityLogs.createdAt})` })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.tenantId, tenantId),
        eq(activityLogs.entityType, 'deal'),
        eq(activityLogs.entityId, dealId),
        inArray(activityLogs.action, GENUINE_ACTIVITY_ACTIONS),
      ),
    );

  const [tsk] = await exec
    .select({ last: sql<Date | null>`max(${tasks.completedAt})` })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.entityType, 'deal'),
        eq(tasks.entityId, dealId),
        eq(tasks.status, 'completed'),
        inArray(tasks.type, GENUINE_TASK_TYPES as Array<'call' | 'email' | 'meeting'>),
        isNull(tasks.deletedAt),
      ),
    );

  const activityDates = [act?.last, tsk?.last]
    .filter((d): d is Date => d != null)
    .map((d) => (d instanceof Date ? d : new Date(d as unknown as string)));
  const lastGenuineActivityAt =
    activityDates.length > 0
      ? new Date(Math.max(...activityDates.map((d) => d.getTime())))
      : null;

  const [counts] = await exec
    .select({
      open: sql<number>`count(*) filter (where ${tasks.status} not in ('completed','cancelled'))::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.status} not in ('completed','cancelled') and ${tasks.dueDate} < current_date)::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.entityType, 'deal'),
        eq(tasks.entityId, dealId),
        isNull(tasks.deletedAt),
      ),
    );

  const [sh] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(dealContacts)
    .where(
      and(eq(dealContacts.tenantId, tenantId), eq(dealContacts.dealId, dealId)),
    );

  const [cur] = await exec
    .select({ enteredAt: dealStageHistory.enteredAt })
    .from(dealStageHistory)
    .where(
      and(
        eq(dealStageHistory.tenantId, tenantId),
        eq(dealStageHistory.dealId, dealId),
        isNull(dealStageHistory.exitedAt),
      ),
    )
    .limit(1);
  const enteredAt = cur?.enteredAt ? new Date(cur.enteredAt) : now;
  const timeInStageDays = Math.max(
    0,
    Math.floor((now.getTime() - enteredAt.getTime()) / MS_PER_DAY),
  );

  return {
    now,
    stage: deal.stage,
    lastGenuineActivityAt,
    timeInStageDays,
    stageMedianDays: medians[deal.stage] ?? FALLBACK_MEDIANS[deal.stage],
    expectedCloseDate: deal.expectedCloseDate,
    stakeholderCount: sh?.n ?? 0,
    nextStep: deal.nextStep,
    openTaskCount: counts?.open ?? 0,
    overdueTaskCount: counts?.overdue ?? 0,
    amountMinor: deal.amountMinor,
  };
}

/** Append a deal_scores row AND refresh the denormalized cache on deals. */
async function persistScore(
  exec: DbExecutor,
  tenantId: string,
  dealId: string,
  result: ReturnType<typeof computeDealScore>,
): Promise<DealScore> {
  const [row] = await exec
    .insert(dealScores)
    .values({
      tenantId,
      dealId,
      score: result.score,
      band: result.band,
      reasons: result.reasons,
    })
    .returning();

  // Raw UPDATE (not the query builder) so drizzle's $onUpdate does NOT bump
  // deals.updated_at — the board pager sorts/cursors on updated_at and a score
  // refresh must not reorder the board.
  await exec.execute(sql`
    UPDATE deals SET health_score = ${result.score}, health_band = ${result.band}
    WHERE id = ${dealId}::uuid AND tenant_id = ${tenantId}::uuid
  `);

  return row!;
}

/**
 * Recompute one deal's health score: gather context, compute, append a
 * deal_scores row, refresh the deals cache. No-op (returns null) when scoring
 * is disabled for the tenant or the deal is closed/missing. `now` is injectable
 * for tests.
 */
export async function recomputeDealScore(
  tenantId: string,
  dealId: string,
  now: Date = new Date(),
): Promise<DealScore | null> {
  return tenantTransaction(async (tx) => {
    if (!(await scoringEnabled(tx, tenantId))) return null;

    const [deal] = await tx
      .select({
        stage: deals.stage,
        expectedCloseDate: deals.expectedCloseDate,
        nextStep: deals.nextStep,
        amountMinor: deals.amountMinor,
      })
      .from(deals)
      .where(
        and(
          eq(deals.id, dealId),
          eq(deals.tenantId, tenantId),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1);
    if (!deal) return null;

    const medians = await getWorkspaceStageMedians(tx, tenantId);
    const ctx = await gatherContext(tx, tenantId, dealId, deal, medians, now);
    if (!ctx) return null;

    const result = computeDealScore(ctx);
    return persistScore(tx, tenantId, dealId, result);
  });
}

/**
 * Recompute every open deal for a tenant (the nightly cron). Shares one median
 * computation and one transaction. Returns how many deals were scored.
 */
export async function recomputeOpenDealsForTenant(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ scored: number }> {
  return tenantTransaction(async (tx) => {
    if (!(await scoringEnabled(tx, tenantId))) return { scored: 0 };

    const openDeals = await tx
      .select({
        id: deals.id,
        stage: deals.stage,
        expectedCloseDate: deals.expectedCloseDate,
        nextStep: deals.nextStep,
        amountMinor: deals.amountMinor,
      })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          inArray(deals.stage, OPEN_STAGES),
          isNull(deals.deletedAt),
        ),
      );

    if (openDeals.length === 0) return { scored: 0 };
    const medians = await getWorkspaceStageMedians(tx, tenantId);

    let scored = 0;
    for (const d of openDeals) {
      const ctx = await gatherContext(tx, tenantId, d.id, d, medians, now);
      if (!ctx) continue;
      await persistScore(tx, tenantId, d.id, computeDealScore(ctx));
      scored += 1;
    }
    return { scored };
  });
}

/* -------- read paths (detail card) -------- */

export type DealScorePoint = {
  score: number;
  band: string;
  computedAt: Date;
};

/**
 * Current score + up to `limit` most-recent history points (newest first) for
 * the deal-detail Deal Score card. `current` is the newest point.
 */
export async function getDealScoreWithHistory(
  tenantId: string,
  dealId: string,
  limit = 30,
): Promise<{
  current: DealScore | null;
  history: DealScorePoint[];
}> {
  return tenantTransaction(async (tx) => {
    const rows = await tx
      .select()
      .from(dealScores)
      .where(
        and(eq(dealScores.tenantId, tenantId), eq(dealScores.dealId, dealId)),
      )
      .orderBy(sql`${dealScores.computedAt} DESC`)
      .limit(limit);

    return {
      current: rows[0] ?? null,
      history: rows.map((r) => ({
        score: r.score,
        band: r.band,
        computedAt: r.computedAt,
      })),
    };
  });
}
