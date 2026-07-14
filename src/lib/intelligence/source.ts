import 'server-only';

import { and, eq, gte, sql } from 'drizzle-orm';

import {
  activityLogs,
  emailMessages,
  tasks,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';
import { UUID_REGEX_LITERAL } from '@/lib/db-sql/safe-uuid';
import { DEAL_STAGES, type DealStage } from '@/lib/deals/schema';

/**
 * Source-text builders. Each function pulls a deterministic projection
 * of the underlying data and renders it as a stable string. The string
 * is hashed; matching hashes ⇒ matching source ⇒ cache hit.
 *
 * Two rules these builders must follow:
 *   1. **No clock-derived fields.** Don't include `Date.now()` or
 *      "minutes ago" — those change every render and would defeat the
 *      cache.
 *   2. **Stable key ordering.** Objects rendered as JSON are always
 *      constructed with a fixed key order so JSON.stringify doesn't
 *      produce two different strings for the same data.
 *
 * Mocking is handled at the model layer (mock.ts), not here. These
 * builders read REAL data even in mock mode so the cache hash stays
 * meaningful.
 */

/**
 * Source for the daily executive summary. Bucketed by UTC date so the
 * hash flips naturally at midnight UTC even with no other changes.
 *
 * Inputs collected:
 *   - tenant id + UTC date
 *   - active-deal count + pipeline total
 *   - won/lost counts in window
 *   - count of stage-change events in window
 *   - count of activities in window
 *   - top 5 most-recent activity headlines (entity name + action)
 */
export async function buildDailyExecSource(
  tenantId: string,
  isoDate: string, // 'YYYY-MM-DD' UTC
): Promise<{ source: string; payload: DailyExecSourcePayload }> {
  const dayStart = new Date(`${isoDate}T00:00:00.000Z`);
  const weekStart = new Date(dayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

  const data = await tenantTransaction(async (tx) => {
    // Pipeline totals (active deals only).
    const pipelineRows = (await tx.execute(sql`
      SELECT
        coalesce(sum(amount_minor), 0)::bigint AS total,
        count(*)::int                          AS count
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND stage IN ('lead','qualified','proposal','negotiation')
    `)) as unknown as Array<{ total: number; count: number }>;

    // Deals closed in window (won + lost), bucketed by status.
    const closedRows = (await tx.execute(sql`
      SELECT stage::text AS stage, count(*)::int AS n,
             coalesce(sum(amount_minor), 0)::bigint AS total
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
        AND stage IN ('won','lost')
        AND closed_at >= ${weekStart.toISOString()}::timestamptz
      GROUP BY stage
    `)) as unknown as Array<{ stage: string; n: number; total: number }>;

    // Stage-change activity count in the past week.
    const stageEvtRows = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.tenantId, tenantId),
          eq(activityLogs.entityType, 'deal'),
          eq(activityLogs.action, 'stage_changed'),
          gte(activityLogs.createdAt, weekStart),
        ),
      )) as Array<{ n: number }>;

    // Recent activity headlines (most-recent 5).
    const topRows = (await tx.execute(sql`
      SELECT entity_type, action, entity_id
      FROM activity_logs
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${weekStart.toISOString()}::timestamptz
      ORDER BY created_at DESC
      LIMIT 5
    `)) as unknown as Array<{
      entity_type: string;
      action: string;
      entity_id: string;
    }>;

    return {
      pipelineTotal: Number(pipelineRows[0]?.total ?? 0),
      activeCount: Number(pipelineRows[0]?.count ?? 0),
      closed: closedRows.map((r) => ({
        stage: r.stage,
        count: Number(r.n),
        total: Number(r.total),
      })),
      stageChangeCount: Number(stageEvtRows[0]?.n ?? 0),
      recent: topRows.map((r) => ({
        type: r.entity_type,
        action: r.action,
        id: r.entity_id,
      })),
    };
  });

  // Deterministic projection. Key order is explicit; arrays are pre-sorted.
  const payload: DailyExecSourcePayload = {
    date: isoDate,
    activeCount: data.activeCount,
    pipelineTotal: data.pipelineTotal,
    stageChangeCount: data.stageChangeCount,
    closed: data.closed.sort((a, b) => a.stage.localeCompare(b.stage)),
    recent: data.recent,
  };

  return { source: stableStringify(payload), payload };
}

export type DailyExecSourcePayload = {
  date: string;
  activeCount: number;
  pipelineTotal: number;
  stageChangeCount: number;
  closed: { stage: string; count: number; total: number }[];
  recent: { type: string; action: string; id: string }[];
};

/**
 * Source for per-deal AI summary. Pulls the deal plus a fixed window
 * of activity + email signal so the hash flips when the deal evolves
 * but not when unrelated rows churn.
 */
export async function buildDealSummarySource(
  tenantId: string,
  dealId: string,
): Promise<{ source: string; dealName: string } | null> {
  const data = await tenantTransaction(async (tx) => {
    const dealRows = (await tx.execute(sql`
      SELECT
        d.id,
        d.name,
        d.stage::text                                AS stage,
        d.amount_minor,
        d.currency,
        d.probability,
        d.owner_id,
        d.expected_close_date,
        d.closed_at,
        d.created_at,
        d.updated_at,
        c.name                                       AS company_name,
        ct.first_name                                AS contact_first,
        ct.last_name                                 AS contact_last
      FROM deals d
      LEFT JOIN companies c  ON c.id  = d.company_id
      LEFT JOIN contacts  ct ON ct.id = d.contact_id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.id = ${dealId}::uuid
        AND d.deleted_at IS NULL
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      name: string;
      stage: string;
      amount_minor: number;
      currency: string;
      probability: number | null;
      owner_id: string | null;
      expected_close_date: string | null;
      closed_at: string | null;
      created_at: string;
      updated_at: string;
      company_name: string | null;
      contact_first: string | null;
      contact_last: string | null;
    }>;
    const deal = dealRows[0];
    if (!deal) return null;

    // Most-recent 10 activity rows on this deal.
    const activityRows = (await tx.execute(sql`
      SELECT action, created_at, metadata
      FROM activity_logs
      WHERE tenant_id = ${tenantId}::uuid
        AND entity_type = 'deal'
        AND entity_id = ${dealId}::text
      ORDER BY created_at DESC
      LIMIT 10
    `)) as unknown as Array<{
      action: string;
      created_at: string;
      metadata: Record<string, unknown>;
    }>;

    // Email signal — last 5 sends linked to the deal.
    const emailRows = (await tx
      .select({
        status: emailMessages.status,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.tenantId, tenantId),
          eq(emailMessages.entityType, 'deal'),
          eq(emailMessages.entityId, dealId),
        ),
      )
      .orderBy(sql`${emailMessages.createdAt} DESC`)
      .limit(5)) as Array<{ status: string; createdAt: Date }>;

    // Open tasks on this deal.
    const taskRows = (await tx
      .select({
        title: tasks.title,
        status: tasks.status,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.entityType, 'deal'),
          eq(tasks.entityId, dealId),
        ),
      )
      .orderBy(sql`${tasks.createdAt} DESC`)
      .limit(5)) as Array<{
      title: string;
      status: string;
      dueDate: string | null;
    }>;

    // Real gap signals: full counts, overdue tasks, stakeholders, and how
    // long the deal has been in its current stage. Counts + a current-stage
    // entry timestamp are stable (no continuous clock field), so they flip
    // the cache when the deal actually evolves — which is exactly when the
    // AI next-actions / confidence should be recomputed.
    const gapRows = (await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM activity_logs a
           WHERE a.tenant_id = ${tenantId}::uuid
             AND a.entity_type = 'deal' AND a.entity_id = ${dealId}::text) AS activity_count,
        (SELECT count(*)::int FROM email_messages e
           WHERE e.tenant_id = ${tenantId}::uuid
             AND e.entity_type = 'deal' AND e.entity_id = ${dealId}::uuid) AS email_count,
        (SELECT count(*)::int FROM tasks t
           WHERE t.tenant_id = ${tenantId}::uuid
             AND t.entity_type = 'deal' AND t.entity_id = ${dealId}::uuid
             AND t.deleted_at IS NULL
             AND t.status IN ('todo','in_progress')
             AND t.due_date IS NOT NULL AND t.due_date < current_date) AS overdue_task_count,
        (SELECT count(*)::int FROM deal_contacts dc
           WHERE dc.tenant_id = ${tenantId}::uuid AND dc.deal_id = ${dealId}::uuid) AS stakeholder_count,
        (SELECT to_char(entered_at, 'YYYY-MM-DD"T"HH24:MI:SS')
           FROM deal_stage_history h
           WHERE h.tenant_id = ${tenantId}::uuid AND h.deal_id = ${dealId}::uuid
             AND h.exited_at IS NULL
           ORDER BY entered_at DESC LIMIT 1) AS stage_entered_at
    `)) as unknown as Array<{
      activity_count: number;
      email_count: number;
      overdue_task_count: number;
      stakeholder_count: number;
      stage_entered_at: string | null;
    }>;

    // Primary stakeholder (for a targeted "follow up with X" next action).
    const primaryRows = (await tx.execute(sql`
      SELECT ct.first_name, ct.last_name, ct.email
      FROM deal_contacts dc
      JOIN contacts ct ON ct.id = dc.contact_id
      WHERE dc.tenant_id = ${tenantId}::uuid
        AND dc.deal_id = ${dealId}::uuid
        AND dc.is_primary
      LIMIT 1
    `)) as unknown as Array<{
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>;

    return { deal, activityRows, emailRows, taskRows, gapRows, primaryRows };
  });
  if (!data) return null;

  const { deal, activityRows, emailRows, taskRows, gapRows, primaryRows } = data;
  const gap = gapRows[0];
  const primary = primaryRows[0];
  const primaryName = primary
    ? [primary.first_name, primary.last_name].filter(Boolean).join(' ') ||
      primary.email ||
      null
    : null;
  const contactName = [deal.contact_first, deal.contact_last]
    .filter(Boolean)
    .join(' ');

  const payload = {
    deal: {
      id: deal.id,
      name: deal.name,
      stage: deal.stage,
      amount_minor: deal.amount_minor,
      currency: deal.currency,
      probability: deal.probability,
      owner_id: deal.owner_id,
      expected_close_date: deal.expected_close_date,
      closed_at: deal.closed_at,
      created_at: deal.created_at,
      updated_at: deal.updated_at,
      company: deal.company_name,
      contact: contactName || null,
    },
    activities: activityRows.map((a) => ({
      action: a.action,
      // truncate to second to avoid clock-noise micro-changes invalidating cache
      at: a.created_at.slice(0, 19),
      metadata: a.metadata,
    })),
    emails: emailRows.map((e) => ({
      status: e.status,
      at: e.createdAt.toISOString().slice(0, 19),
    })),
    tasks: taskRows.map((t) => ({
      title: t.title,
      status: t.status,
      dueDate: t.dueDate ?? null,
    })),
    signals: {
      activityCount: Number(gap?.activity_count ?? 0),
      emailCount: Number(gap?.email_count ?? 0),
      overdueTaskCount: Number(gap?.overdue_task_count ?? 0),
      stakeholderCount: Number(gap?.stakeholder_count ?? 0),
      stageEnteredAt: gap?.stage_entered_at ?? null,
      primaryContactName: primaryName,
    },
  };

  return { source: stableStringify(payload), dealName: deal.name };
}

/**
 * Source for risk-flag set. The model receives a digest of the riskiest
 * deals plus tenant-wide signals. We pre-rank candidates here so the
 * prompt doesn't have to do the math.
 */
export async function buildRiskFlagSource(
  tenantId: string,
): Promise<{ source: string; candidates: RiskCandidate[] }> {
  const candidates = await tenantTransaction(async (tx) => {
    // Stale-ish deals: active stage, no activity in 14d, or no email in 9d.
    const cutoffActivity = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const cutoffEmail = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);

    const rows = (await tx.execute(sql`
      WITH last_act AS (
        -- entity_id is a polymorphic text column; restrict to UUID-shaped
        -- values before casting so a non-uuid row (e.g. a future entity
        -- type we don't filter on, or legacy data) cannot crash the page.
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        GROUP BY entity_id
      ),
      last_email AS (
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM email_messages
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id IS NOT NULL
          AND entity_id::text ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        GROUP BY entity_id
      )
      SELECT
        d.id                                         AS deal_id,
        d.name                                       AS name,
        d.stage::text                                AS stage,
        d.amount_minor                               AS amount_minor,
        d.probability                                AS probability,
        d.owner_id                                   AS owner_id,
        la.at                                        AS last_activity_at,
        le.at                                        AS last_email_at,
        (la.at IS NULL OR la.at < ${cutoffActivity.toISOString()}::timestamptz) AS stale_activity,
        (le.at IS NULL OR le.at < ${cutoffEmail.toISOString()}::timestamptz)    AS stale_email
      FROM deals d
      LEFT JOIN last_act   la ON la.deal_id = d.id
      LEFT JOIN last_email le ON le.deal_id = d.id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.deleted_at IS NULL
        AND d.stage IN ('lead','qualified','proposal','negotiation')
        AND (la.at IS NULL OR la.at < ${cutoffActivity.toISOString()}::timestamptz
             OR le.at IS NULL OR le.at < ${cutoffEmail.toISOString()}::timestamptz)
      ORDER BY d.amount_minor DESC NULLS LAST
      LIMIT 12
    `)) as unknown as Array<{
      deal_id: string;
      name: string;
      stage: string;
      amount_minor: number;
      probability: number | null;
      owner_id: string | null;
      last_activity_at: string | null;
      last_email_at: string | null;
      stale_activity: boolean;
      stale_email: boolean;
    }>;

    return rows.map((r) => ({
      dealId: r.deal_id,
      name: r.name,
      stage: r.stage,
      amountMinor: Number(r.amount_minor),
      probability: r.probability,
      ownerId: r.owner_id,
      lastActivityAt: r.last_activity_at?.slice(0, 19) ?? null,
      lastEmailAt: r.last_email_at?.slice(0, 19) ?? null,
      staleActivity: Boolean(r.stale_activity),
      staleEmail: Boolean(r.stale_email),
    }));
  });

  return {
    source: stableStringify({
      candidates,
      thresholds: { activityDays: 14, emailDays: 9 },
    }),
    candidates,
  };
}

export type RiskCandidate = {
  dealId: string;
  name: string;
  stage: string;
  amountMinor: number;
  probability: number | null;
  ownerId: string | null;
  lastActivityAt: string | null;
  lastEmailAt: string | null;
  staleActivity: boolean;
  staleEmail: boolean;
};

/**
 * Source for the recommendation set. Pulls candidates similar to risk
 * flags but with a focus on what the user could ACT on next, not just
 * what's wrong.
 */
export async function buildRecommendationSource(
  tenantId: string,
): Promise<{ source: string; candidates: RecCandidate[] }> {
  const candidates = await tenantTransaction(async (tx) => {
    const rows = (await tx.execute(sql`
      WITH last_act AS (
        -- Guard the polymorphic entity_id cast — see safe-uuid.ts.
        SELECT entity_id::uuid AS deal_id, max(created_at) AS at
        FROM activity_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND entity_type = 'deal'
          AND entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        GROUP BY entity_id
      )
      SELECT
        d.id                                         AS deal_id,
        d.name                                       AS name,
        d.stage::text                                AS stage,
        d.amount_minor                               AS amount_minor,
        d.probability                                AS probability,
        d.owner_id                                   AS owner_id,
        d.expected_close_date                        AS expected_close_date,
        d.created_at                                 AS created_at,
        la.at                                        AS last_activity_at,
        (
          SELECT count(*)::int
          FROM tasks t
          WHERE t.tenant_id = d.tenant_id
            AND t.entity_type = 'deal'
            AND t.entity_id = d.id
            AND t.status IN ('todo','in_progress')
            AND t.due_date IS NOT NULL
            AND t.due_date < current_date
        )                                            AS overdue_tasks
      FROM deals d
      LEFT JOIN last_act la ON la.deal_id = d.id
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.deleted_at IS NULL
        AND d.stage IN ('lead','qualified','proposal','negotiation')
      ORDER BY d.amount_minor DESC NULLS LAST
      LIMIT 15
    `)) as unknown as Array<{
      deal_id: string;
      name: string;
      stage: string;
      amount_minor: number;
      probability: number | null;
      owner_id: string | null;
      expected_close_date: string | null;
      created_at: string;
      last_activity_at: string | null;
      overdue_tasks: number;
    }>;
    return rows.map((r) => ({
      dealId: r.deal_id,
      name: r.name,
      stage: r.stage,
      amountMinor: Number(r.amount_minor),
      probability: r.probability,
      ownerId: r.owner_id,
      expectedCloseDate: r.expected_close_date,
      createdAt: r.created_at,
      lastActivityAt: r.last_activity_at?.slice(0, 19) ?? null,
      overdueTasks: Number(r.overdue_tasks),
    }));
  });

  return { source: stableStringify(candidates), candidates };
}

export type RecCandidate = {
  dealId: string;
  name: string;
  stage: string;
  amountMinor: number;
  probability: number | null;
  ownerId: string | null;
  expectedCloseDate: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  overdueTasks: number;
};

/**
 * Source for pipeline-summary. Pulls per-stage counts + amounts so the
 * model can narrate where the pipeline is concentrated and which stages
 * look healthy vs. stalled.
 */
export async function buildPipelineSummarySource(
  tenantId: string,
): Promise<{ source: string; payload: PipelineSummarySourcePayload }> {
  const stageRows = await tenantTransaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT stage::text AS stage,
             count(*)::int AS n,
             coalesce(sum(amount_minor), 0)::bigint AS total
      FROM deals
      WHERE tenant_id = ${tenantId}::uuid
        AND deleted_at IS NULL
      GROUP BY stage
    `)) as unknown as Array<{ stage: string; n: number; total: number }>;
    return rows;
  });

  const byStage = new Map<DealStage, { count: number; totalAmountMinor: number }>();
  for (const r of stageRows) {
    byStage.set(r.stage as DealStage, {
      count: Number(r.n),
      totalAmountMinor: Number(r.total),
    });
  }
  const payload: PipelineSummarySourcePayload = {
    perStage: DEAL_STAGES.map((s) => ({
      stage: s,
      count: byStage.get(s)?.count ?? 0,
      totalAmountMinor: byStage.get(s)?.totalAmountMinor ?? 0,
    })),
  };

  return { source: stableStringify(payload), payload };
}

export type PipelineSummarySourcePayload = {
  perStage: {
    stage: DealStage;
    count: number;
    totalAmountMinor: number;
  }[];
};

/**
 * Source for a per-thread AI summary. Pulls the thread row + its
 * messages + the last events so the model has the context to write
 * a narrative + extract unresolved / next-action / risk bullets.
 *
 * Source hash includes message ids + timestamps + the latest event id,
 * so a new message naturally invalidates the cache without an explicit
 * flush.
 */
export async function buildThreadSummarySource(
  tenantId: string,
  threadId: string,
): Promise<{ source: string; threadSubject: string } | null> {
  type ThreadRow = {
    id: string;
    subject_raw: string;
    last_message_at: string;
    message_count: number;
    failed_count: number;
    entity_type: string | null;
    entity_id: string | null;
  };
  const threadRows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT id::text, subject_raw, last_message_at::text, message_count,
             failed_count, entity_type, entity_id::text AS entity_id
      FROM communication_threads
      WHERE tenant_id = ${tenantId}::uuid AND id = ${threadId}::uuid
      LIMIT 1
    `),
  )) as unknown as ThreadRow[];
  const thread = threadRows[0];
  if (!thread) return null;

  type MsgRow = {
    id: string;
    sender: string;
    to_recipients: string[];
    subject: string;
    text_body: string;
    status: string;
    created_at: string;
  };
  const messageRows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT id::text, sender, to_recipients, subject, text_body,
             status, created_at::text
      FROM email_messages
      WHERE tenant_id = ${tenantId}::uuid AND thread_id = ${threadId}::uuid
      ORDER BY created_at ASC
      LIMIT 40
    `),
  )) as unknown as MsgRow[];

  type EventRow = { event_kind: string; created_at: string };
  const eventRows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT event_kind, created_at::text
      FROM communication_events
      WHERE tenant_id = ${tenantId}::uuid AND thread_id = ${threadId}::uuid
      ORDER BY created_at DESC
      LIMIT 20
    `),
  )) as unknown as EventRow[];

  const payload = {
    thread: {
      id: thread.id,
      subject: thread.subject_raw,
      messageCount: thread.message_count,
      failedCount: thread.failed_count,
      entityType: thread.entity_type,
      entityId: thread.entity_id,
      // Truncate timestamp to second to avoid micro-noise invalidation.
      lastMessageAt: thread.last_message_at.slice(0, 19),
    },
    messages: messageRows.map((m) => ({
      id: m.id,
      sender: m.sender,
      to: m.to_recipients,
      subject: m.subject,
      // Cap body so the prompt budget stays bounded.
      preview: (m.text_body ?? '').slice(0, 600),
      status: m.status,
      at: m.created_at.slice(0, 19),
    })),
    events: eventRows.map((e) => ({
      kind: e.event_kind,
      at: e.created_at.slice(0, 19),
    })),
  };

  return {
    source: stableStringify(payload),
    threadSubject: thread.subject_raw,
  };
}

/**
 * Deterministic JSON stringifier. Sorts object keys at every level so
 * we get the same output for the same logical content even when builder
 * code constructs objects in a different key order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sortedKeys = Object.keys(v).sort();
      const out: Record<string, unknown> = {};
      for (const k of sortedKeys) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}
