import 'server-only';

import { and, eq } from 'drizzle-orm';

import { aiSummaries, type EmbeddedEntityType } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

export type CachedSummary = {
  summary: string;
  generatedAt: Date;
  model: string;
};

/**
 * Read-side projection of `ai_summaries`. The page renders the cached
 * summary on first paint; the client-side regenerate button refreshes it
 * via the `generateEntitySummary` action.
 */
export async function getCachedSummary(
  tenantId: string,
  entityType: EmbeddedEntityType,
  entityId: string,
): Promise<CachedSummary | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        summary: aiSummaries.summary,
        generatedAt: aiSummaries.generatedAt,
        model: aiSummaries.model,
      })
      .from(aiSummaries)
      .where(
        and(
          eq(aiSummaries.tenantId, tenantId),
          eq(aiSummaries.entityType, entityType),
          eq(aiSummaries.entityId, entityId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}
