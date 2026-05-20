import 'server-only';

import { and, eq } from 'drizzle-orm';

import { aiSummaries, type AiSummary } from '@/db/schema';
import { hashContent } from '@/lib/ai/embed';
import { tenantTransaction } from '@/lib/db-context';

import type { InsightState, InsightType } from './types';

/**
 * Read-through cache for any insight type. The contract is:
 *
 *   1. Caller passes a `(tenantId, entityType, entityId, sourceText)` tuple.
 *   2. We hash the source, look up the row.
 *   3. Three cases:
 *        a) row exists with matching hash → return `cached` + content
 *        b) row exists with different hash → return `stale` + old content
 *           (regen up to caller via enqueueing)
 *        c) no row → return `generating` + null
 *   4. Caller decides what to do with stale/generating. The page renders
 *      whatever it got; an Inngest job will UPSERT and publish a realtime
 *      event when fresh content is ready.
 *
 * This file does NOT enqueue regeneration — that lives in src/lib/intelligence/runner.ts.
 * Keeping the read path side-effect-free makes it safe to call from SSR.
 *
 * Entity-id conventions for aggregate insight types:
 *   daily-exec           → "YYYY-MM-DD" (the UTC date being summarized)
 *   pipeline-summary     → "global"
 *   risk-flag-set        → "global"
 *   recommendation-set   → "global"
 *   deal-summary         → the deal uuid
 *   activity-summary     → the entity uuid being narrated
 */

export type CacheLookup<T = string> = {
  state: InsightState;
  /** Cached content (string for narrative types, JSON.stringified for structured). */
  content: T | null;
  /** When the row was last UPSERTed (null for generating). */
  generatedAt: Date | null;
  /** Summary row id (needed by the feedback API). */
  summaryId: string | null;
  /** Hash of the current source — what a fresh regen would write. */
  sourceHash: string;
  /** Hash on the stored row (null when no row exists). */
  storedHash: string | null;
};

/**
 * Look up the cached insight for an entity. Returns the row plus a
 * computed `state` enum so callers can render the right badge without
 * re-deriving it.
 *
 * sourceText is hashed; the caller is responsible for building a
 * deterministic projection of the underlying data (NOT including
 * timestamps that change every render).
 */
export async function readInsight(
  tenantId: string,
  insightType: InsightType,
  entityId: string,
  sourceText: string,
): Promise<CacheLookup> {
  const sourceHash = hashContent(sourceText);

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: aiSummaries.id,
        summary: aiSummaries.summary,
        sourceHash: aiSummaries.sourceHash,
        generatedAt: aiSummaries.generatedAt,
      })
      .from(aiSummaries)
      .where(
        and(
          eq(aiSummaries.tenantId, tenantId),
          eq(aiSummaries.entityType, insightType),
          eq(aiSummaries.entityId, entityId),
        ),
      )
      .limit(1),
  );

  const row = rows[0];

  if (!row) {
    return {
      state: 'generating',
      content: null,
      generatedAt: null,
      summaryId: null,
      sourceHash,
      storedHash: null,
    };
  }

  return {
    state: row.sourceHash === sourceHash ? 'cached' : 'stale',
    content: row.summary,
    generatedAt: row.generatedAt,
    summaryId: row.id,
    sourceHash,
    storedHash: row.sourceHash,
  };
}

/**
 * UPSERT a fresh insight and return the row. Used by the Inngest job
 * and by synchronous "regenerate now" actions (rare — pages should
 * prefer the async path).
 *
 * Wrapped in `tenantTransaction` so the GUC is set and the row write
 * passes RLS. Realtime publish is the caller's responsibility — the
 * cache writer doesn't know which channel to fire on a per-call basis
 * (we want to fire once at the END of a multi-summary refresh, not on
 * every UPSERT).
 */
export async function writeInsight(input: {
  tenantId: string;
  insightType: InsightType;
  entityId: string;
  /** Content to store. For structured outputs, JSON.stringify upstream. */
  content: string;
  model: string;
  sourceHash: string;
}): Promise<AiSummary> {
  return await tenantTransaction(async (tx) => {
    const [row] = await tx
      .insert(aiSummaries)
      .values({
        tenantId: input.tenantId,
        entityType: input.insightType,
        entityId: input.entityId,
        summary: input.content,
        model: input.model,
        sourceHash: input.sourceHash,
      })
      .onConflictDoUpdate({
        target: [
          aiSummaries.tenantId,
          aiSummaries.entityType,
          aiSummaries.entityId,
        ],
        set: {
          summary: input.content,
          model: input.model,
          sourceHash: input.sourceHash,
          generatedAt: new Date(),
        },
      })
      .returning();
    if (!row) {
      throw new Error('UPSERT returned no row — RLS or tenant context issue');
    }
    return row;
  });
}

/**
 * Cache hit ratio for an insight type over the last N hours. Read from
 * ai_invocations.metadata. Surfaced by the ops dashboard.
 */
export type CacheHitMetric = {
  insightType: InsightType;
  totalReads: number;
  cacheHits: number;
  hitRatio: number;
};
