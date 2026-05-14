import 'server-only';

import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { aiInvocations, emailMessages, workflowRuns } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export type AIInvocationRow = {
  id: string;
  kind: string;
  model: string;
  status: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  createdAt: Date;
  metadata: unknown;
  error: string | null;
  actorUserId: string | null;
};

export type AIInvocationStats = {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  totalTokens: number;
  byKind: Array<{ kind: string; count: number; tokens: number }>;
};

export type WorkflowRunRow = {
  id: string;
  workflowId: string;
  eventName: string | null;
  inngestRunId: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
};

export type WorkflowStats = {
  totalRuns: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  byWorkflow: Array<{ workflowId: string; runs: number; failed: number; avgMs: number | null }>;
};

const RECENT_AI_LIMIT = 25;
const RECENT_RUNS_LIMIT = 25;

export async function getRecentAiInvocations(
  tenantId: string,
): Promise<AIInvocationRow[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: aiInvocations.id,
        kind: aiInvocations.kind,
        model: aiInvocations.model,
        status: aiInvocations.status,
        promptTokens: aiInvocations.promptTokens,
        completionTokens: aiInvocations.completionTokens,
        totalTokens: aiInvocations.totalTokens,
        latencyMs: aiInvocations.latencyMs,
        createdAt: aiInvocations.createdAt,
        metadata: aiInvocations.metadata,
        error: aiInvocations.error,
        actorUserId: aiInvocations.actorUserId,
      })
      .from(aiInvocations)
      .where(eq(aiInvocations.tenantId, tenantId))
      .orderBy(desc(aiInvocations.createdAt))
      .limit(RECENT_AI_LIMIT),
  );
  return rows;
}

export async function getAiInvocationStats(
  tenantId: string,
  windowHours = 24,
): Promise<AIInvocationStats> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const totals = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        COUNT(*)::int            AS total,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success,
        COUNT(*) FILTER (WHERE status = 'error')::int   AS error,
        COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
        COALESCE(SUM(total_tokens), 0)::int             AS tokens
      FROM ai_invocations
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${since.toISOString()}
    `),
  );
  const t = (totals as unknown as Array<{
    total: number; success: number; error: number; skipped: number; tokens: number;
  }>)[0] ?? { total: 0, success: 0, error: 0, skipped: 0, tokens: 0 };

  const perKind = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        kind,
        COUNT(*)::int              AS count,
        COALESCE(SUM(total_tokens), 0)::int AS tokens
      FROM ai_invocations
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${since.toISOString()}
      GROUP BY kind
      ORDER BY count DESC
    `),
  );
  const byKind = (perKind as unknown as Array<{ kind: string; count: number; tokens: number }>) ?? [];

  return {
    totalCalls: t.total,
    successCount: t.success,
    errorCount: t.error,
    skippedCount: t.skipped,
    totalTokens: t.tokens,
    byKind: byKind.map((r) => ({ kind: r.kind, count: r.count, tokens: r.tokens })),
  };
}

export async function getRecentWorkflowRuns(
  tenantId: string,
): Promise<WorkflowRunRow[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({
        id: workflowRuns.id,
        workflowId: workflowRuns.workflowId,
        eventName: workflowRuns.eventName,
        inngestRunId: workflowRuns.inngestRunId,
        status: workflowRuns.status,
        startedAt: workflowRuns.startedAt,
        completedAt: workflowRuns.completedAt,
        error: workflowRuns.error,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.tenantId, tenantId))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(RECENT_RUNS_LIMIT),
  );
}

export async function getWorkflowStats(
  tenantId: string,
  windowHours = 24,
): Promise<WorkflowStats> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const totals = await tenantTransaction(async (tx) =>
    tx
      .select({
        status: workflowRuns.status,
        // count(*)
        n: sql<number>`count(*)::int`,
      })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.tenantId, tenantId),
          gte(workflowRuns.startedAt, since),
        ),
      )
      .groupBy(workflowRuns.status),
  );

  const sumStatus = (status: string): number =>
    totals.find((r) => r.status === status)?.n ?? 0;
  const total = totals.reduce((s, r) => s + r.n, 0);

  const perWorkflow = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        workflow_id              AS "workflowId",
        COUNT(*)::int            AS runs,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
          FILTER (WHERE completed_at IS NOT NULL) AS "avgMs"
      FROM workflow_runs
      WHERE tenant_id = ${tenantId}::uuid
        AND started_at >= ${since.toISOString()}
      GROUP BY workflow_id
      ORDER BY runs DESC
    `),
  );
  const byWorkflow = (perWorkflow as unknown as Array<{
    workflowId: string; runs: number; failed: number; avgMs: number | string | null;
  }>) ?? [];

  return {
    totalRuns: total,
    running: sumStatus('running'),
    completed: sumStatus('completed'),
    failed: sumStatus('failed'),
    skipped: sumStatus('skipped'),
    byWorkflow: byWorkflow.map((r) => ({
      workflowId: r.workflowId,
      runs: r.runs,
      failed: r.failed,
      avgMs: r.avgMs == null ? null : Number(r.avgMs),
    })),
  };
}

export type EmailDeliveryStats = {
  windowHours: number;
  total: number;
  sent: number;
  delivered: number;
  queued: number;
  sending: number;
  failed: number;
  /** Failures that still have retry budget left (retryable=true, capped at 3 attempts). */
  retryable: number;
  /** Failed rows that have run out of retry budget. */
  exhausted: number;
  /** Provider breakdown of recent traffic. */
  byProvider: Array<{ provider: string; count: number; failed: number }>;
  /** Most recent failures, useful for surfacing on the ops page. */
  recentFailures: Array<{
    id: string;
    subject: string;
    error: string | null;
    retryCount: number;
    provider: string;
    recipientLabel: string;
    createdAt: Date;
  }>;
};

/**
 * Email delivery snapshot used by the ops dashboard. Buckets recent
 * email_messages rows by their status state machine and pulls the
 * latest failures for an "attention needed" panel.
 */
export async function getEmailDeliveryStats(
  tenantId: string,
  windowHours = 24,
): Promise<EmailDeliveryStats> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const byStatus = await tenantTransaction(async (tx) =>
    tx
      .select({
        status: emailMessages.status,
        n: sql<number>`count(*)::int`,
      })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.tenantId, tenantId),
          gte(emailMessages.createdAt, since),
        ),
      )
      .groupBy(emailMessages.status),
  );

  const lookup = (s: string): number =>
    byStatus.find((r) => r.status === s)?.n ?? 0;

  // Split failed → retryable vs exhausted via retryCount threshold (3).
  const failureSplits = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE retry_count < 3)::int  AS retryable,
        COUNT(*) FILTER (WHERE retry_count >= 3)::int AS exhausted
      FROM email_messages
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'failed'
        AND created_at >= ${since.toISOString()}
    `),
  );
  const splits = (failureSplits as unknown as Array<{
    retryable: number;
    exhausted: number;
  }>)[0] ?? { retryable: 0, exhausted: 0 };

  const perProvider = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        provider                                  AS provider,
        COUNT(*)::int                             AS count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM email_messages
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${since.toISOString()}
      GROUP BY provider
      ORDER BY count DESC
    `),
  );

  const recentFailures = await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        id, subject, error,
        retry_count       AS "retryCount",
        provider,
        to_recipients[1]  AS "recipientLabel",
        created_at        AS "createdAt"
      FROM email_messages
      WHERE tenant_id = ${tenantId}::uuid
        AND status = 'failed'
      ORDER BY created_at DESC
      LIMIT 5
    `),
  );

  const total = byStatus.reduce((s, r) => s + r.n, 0);
  return {
    windowHours,
    total,
    sent: lookup('sent'),
    delivered: lookup('delivered'),
    queued: lookup('queued'),
    sending: lookup('sending'),
    failed: lookup('failed'),
    retryable: splits.retryable,
    exhausted: splits.exhausted,
    byProvider: (perProvider as unknown as Array<{
      provider: string;
      count: number;
      failed: number;
    }>).map((r) => ({ provider: r.provider, count: r.count, failed: r.failed })),
    recentFailures: (recentFailures as unknown as Array<{
      id: string;
      subject: string;
      error: string | null;
      retryCount: number;
      provider: string;
      recipientLabel: string | null;
      createdAt: Date | string;
    }>).map((r) => ({
      id: r.id,
      subject: r.subject,
      error: r.error,
      retryCount: r.retryCount,
      provider: r.provider,
      recipientLabel: r.recipientLabel ?? '(no recipients)',
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    })),
  };
}
