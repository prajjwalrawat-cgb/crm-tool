import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { aiFeedback, aiSummaries, type AiFeedbackVerdict } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Record a feedback vote on an AI insight. UPSERTs so a user can change
 * their mind (👍 → 👎) and we keep one row per (tenant, summary, user).
 *
 * Returns the verdict that's now stored so the optimistic client can
 * reconcile if it lost a race.
 */
export async function recordAiFeedback(input: {
  tenantId: string;
  userId: string;
  summaryId: string;
  verdict: AiFeedbackVerdict;
  reason?: string | null;
}): Promise<{ verdict: AiFeedbackVerdict }> {
  return await tenantTransaction(async (tx) => {
    // Confirm the summary belongs to this tenant — defensive against a
    // forged summaryId in the request body.
    const [summary] = await tx
      .select({ id: aiSummaries.id })
      .from(aiSummaries)
      .where(
        and(
          eq(aiSummaries.id, input.summaryId),
          eq(aiSummaries.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    if (!summary) {
      throw new Error('Summary not found in this tenant');
    }

    await tx
      .insert(aiFeedback)
      .values({
        tenantId: input.tenantId,
        summaryId: input.summaryId,
        userId: input.userId,
        verdict: input.verdict,
        reason: input.reason ?? null,
      })
      .onConflictDoUpdate({
        target: [aiFeedback.tenantId, aiFeedback.summaryId, aiFeedback.userId],
        set: {
          verdict: input.verdict,
          reason: input.reason ?? null,
          updatedAt: new Date(),
        },
      });

    return { verdict: input.verdict };
  });
}

/**
 * Aggregate helpful-rate per insight type. Ops dashboard read.
 */
export async function summarizeAiFeedback(tenantId: string): Promise<
  Array<{
    insightType: string;
    helpful: number;
    notHelpful: number;
    dismissed: number;
    helpfulRate: number;
  }>
> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT
        s.entity_type AS "insightType",
        count(*) FILTER (WHERE f.verdict = 'helpful')::int     AS helpful,
        count(*) FILTER (WHERE f.verdict = 'not_helpful')::int AS not_helpful,
        count(*) FILTER (WHERE f.verdict = 'dismissed')::int   AS dismissed
      FROM ai_feedback f
      INNER JOIN ai_summaries s ON s.id = f.summary_id
      WHERE f.tenant_id = ${tenantId}::uuid
      GROUP BY s.entity_type
    `),
  )) as unknown as Array<{
    insightType: string;
    helpful: number;
    not_helpful: number;
    dismissed: number;
  }>;

  return rows.map((r) => {
    const total = r.helpful + r.not_helpful;
    return {
      insightType: r.insightType,
      helpful: r.helpful,
      notHelpful: r.not_helpful,
      dismissed: r.dismissed,
      helpfulRate: total === 0 ? 0 : r.helpful / total,
    };
  });
}
