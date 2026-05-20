import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import { agentPatterns, type AgentPattern } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import {
  PATTERN_THRESHOLDS,
  type PatternType,
} from './types';

/**
 * Read every published pattern of a given type for a tenant. The
 * recommendation runner calls this once per candidate set, not per
 * candidate — the result fits comfortably in memory (typical: < 50
 * patterns per type per tenant).
 *
 * Patterns below `NOISE_FLOOR` are filtered out at the DB level so
 * the scoring loop doesn't have to second-guess freshness.
 */
export async function listPatternsByType(
  tenantId: string,
  patternType: PatternType,
): Promise<AgentPattern[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(agentPatterns)
      .where(
        and(
          eq(agentPatterns.tenantId, tenantId),
          eq(agentPatterns.patternType, patternType),
          sql`${agentPatterns.confidenceScore} >= ${PATTERN_THRESHOLDS.NOISE_FLOOR}`,
          sql`${agentPatterns.supportingSampleSize} >= ${PATTERN_THRESHOLDS.MIN_SAMPLE_SIZE}`,
        ),
      ),
  );
}

/**
 * Per-tenant pattern stats — used by the ops dashboard to show
 * "we know N patterns about this workspace".
 */
export async function patternCountByType(
  tenantId: string,
): Promise<Record<string, number>> {
  const rows = (await tenantTransaction(async (tx) =>
    tx.execute(sql`
      SELECT pattern_type, count(*)::int AS n
      FROM agent_patterns
      WHERE tenant_id = ${tenantId}::uuid
        AND confidence_score >= ${PATTERN_THRESHOLDS.NOISE_FLOOR}
        AND supporting_sample_size >= ${PATTERN_THRESHOLDS.MIN_SAMPLE_SIZE}
      GROUP BY pattern_type
    `),
  )) as unknown as Array<{ pattern_type: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.pattern_type, Number(r.n)]));
}
