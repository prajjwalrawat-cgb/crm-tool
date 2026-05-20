import 'server-only';

import { and, eq, gte, sql } from 'drizzle-orm';

import { aiInvocations } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

/**
 * Per-tenant daily token ceiling. The default is 200k — enough for
 * typical-scale intelligence refreshes (a few hundred summary calls)
 * but cheap to override per environment.
 *
 * Counted across all AI kinds (embed, chat, summary, search) since
 * they share an OpenAI bill. The ops dashboard surfaces remaining
 * budget alongside generation activity.
 */
const DEFAULT_DAILY_TOKEN_LIMIT = 200_000;

function readLimit(): number {
  const raw = process.env.AI_TENANT_DAILY_TOKEN_LIMIT;
  if (!raw) return DEFAULT_DAILY_TOKEN_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_TOKEN_LIMIT;
}

export type BudgetCheck = {
  /** True if the call should be allowed. */
  ok: boolean;
  /** Tokens used in the last 24h. */
  tokensUsed: number;
  /** Configured ceiling. */
  tokensLimit: number;
  /** Tokens we estimate this call would consume. */
  estimatedCost: number;
};

/**
 * Pre-flight budget check. Sum ai_invocations.totalTokens for the past
 * 24h, refuse if the new call would push past the ceiling. Returns a
 * structured result so the caller can audit a `status='skipped'` row
 * and surface a friendly state to the UI instead of crashing.
 *
 * For mock mode the caller should skip this check entirely (mock has
 * no real cost). It runs in `live` mode only.
 */
export async function checkBudget(
  tenantId: string,
  estimatedCost: number,
): Promise<BudgetCheck> {
  const limit = readLimit();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        used: sql<number>`coalesce(sum(${aiInvocations.totalTokens}), 0)::bigint`,
      })
      .from(aiInvocations)
      .where(
        and(
          eq(aiInvocations.tenantId, tenantId),
          gte(aiInvocations.createdAt, cutoff),
        ),
      ),
  );

  const tokensUsed = Number(rows[0]?.used ?? 0);
  const ok = tokensUsed + estimatedCost <= limit;

  return { ok, tokensUsed, tokensLimit: limit, estimatedCost };
}
