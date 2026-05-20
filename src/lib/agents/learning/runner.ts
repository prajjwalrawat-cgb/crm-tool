import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

import { getDeriverFor, listEnabledPatternTypes, type DerivationStats } from '../patterns/registry';

/**
 * Top-level "derive all patterns for this tenant" entry point. Called
 * by the nightly Inngest job, and exposed so admin tooling can force
 * a re-derive on demand.
 *
 * Window defaults: 90 days back. That's a conservative middle ground
 * — long enough to accumulate signal, short enough that stale
 * behavior doesn't keep showing up after a workflow change.
 */
export async function deriveAllPatternsForTenant(input: {
  tenantId: string;
  windowDays?: number;
}): Promise<DerivationStats[]> {
  const windowDays = input.windowDays ?? 90;
  const now = new Date();
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const windowFromIso = from.toISOString();
  const windowToIso = now.toISOString();

  const stats: DerivationStats[] = [];
  for (const patternType of listEnabledPatternTypes()) {
    const deriver = getDeriverFor(patternType);
    if (!deriver) continue;
    try {
      const result = await deriver({
        tenantId: input.tenantId,
        windowFromIso,
        windowToIso,
      });
      stats.push(result);
    } catch (err) {
      console.error(`[learning] deriver ${patternType} failed`, err);
      stats.push({
        patternType,
        observed: 0,
        patternsWritten: 0,
        patternsSkipped: 0,
        durationMs: 0,
      });
    }
  }
  return stats;
}

/**
 * Walk every tenant and derive. Used by the nightly Inngest job.
 * Tenants without any deal activity are skipped cheaply (the
 * inner queries return zero rows fast).
 */
export async function deriveAllPatternsForAllTenants(input?: {
  windowDays?: number;
}): Promise<Array<{ tenantId: string; stats: DerivationStats[] }>> {
  const tenantRows = (await db.execute(sql`
    SELECT id::text AS id FROM tenants ORDER BY created_at ASC
  `)) as unknown as Array<{ id: string }>;

  const out: Array<{ tenantId: string; stats: DerivationStats[] }> = [];
  for (const t of tenantRows) {
    const stats = await deriveAllPatternsForTenant({
      tenantId: t.id,
      windowDays: input?.windowDays,
    });
    out.push({ tenantId: t.id, stats });
  }
  return out;
}
