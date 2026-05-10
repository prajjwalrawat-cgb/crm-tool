'use server';

import { z } from 'zod';

import { generateEntitySummary } from '@/lib/ai/summary';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';

const inputSchema = z.object({
  dealId: z.uuid({ message: 'Invalid deal id' }),
  force: z.boolean().optional(),
});

export type GenerateDealSummaryResult =
  | {
      ok: true;
      summary: string;
      cached: boolean;
      generatedAt: string;
    }
  | { ok: false; message: string };

/**
 * On-demand deal summary action. Reuses the cached `ai_summaries` row when
 * the source content hasn't changed (sourceHash dedup); otherwise fires a
 * fresh `gpt-4o-mini` call. Permission gated through `manageDeals` — same
 * permission required to *modify* the deal, since a summary leaks the
 * same data the deal page already shows.
 */
export async function generateDealSummaryAction(
  input: unknown,
): Promise<GenerateDealSummaryResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid deal id.' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      try {
        const summary = await generateEntitySummary({
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: parsed.data.dealId,
          force: parsed.data.force,
        });
        if (!summary) {
          return { ok: false as const, message: 'Deal not found in this tenant.' };
        }
        return {
          ok: true as const,
          summary: summary.summary,
          cached: summary.status === 'cached',
          generatedAt: summary.generatedAt.toISOString(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Summary failed';
        return { ok: false as const, message };
      }
    },
  );
}
