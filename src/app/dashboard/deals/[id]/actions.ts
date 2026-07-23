'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deals } from '@/db/schema';
import { generateEntitySummary } from '@/lib/ai/summary';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';

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

/* ------------------------------------------------------------------ */
/* Manual activity logging (calls / meetings)                          */
/* ------------------------------------------------------------------ */

const logActivitySchema = z.object({
  dealId: z.uuid({ message: 'Invalid deal id' }),
  type: z.enum(['call', 'meeting']),
  occurredAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .nullable(),
  notes: z.string().max(4000).optional().nullable(),
});

export type LogActivityResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Record a call/meeting that didn't flow through an integration. Writes a
 * `call_logged` / `meeting_logged` row to `activity_logs` — the same feed the
 * timeline and AI analysis read — so a phone call becomes real signal.
 */
export async function logDealActivityAction(
  input: unknown,
): Promise<LogActivityResult> {
  const parsed = logActivitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Please fill in the activity details.' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // Confirm the deal exists in this tenant before writing activity.
      const [deal] = await tenantTransaction(async (tx) =>
        tx
          .select({ id: deals.id, name: deals.name })
          .from(deals)
          .where(
            and(
              eq(deals.id, parsed.data.dealId),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1),
      );
      if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

      await tenantTransaction(async (tx) => {
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: deal.id,
          action: parsed.data.type === 'call' ? 'call_logged' : 'meeting_logged',
          metadata: {
            name: deal.name,
            occurredAt: parsed.data.occurredAt ?? null,
            notes: parsed.data.notes ?? null,
          },
        });
      });

      // A logged call/meeting is genuine activity → refresh the health score.
      await queueDealScoreRecompute(tenant.id, deal.id, 'activity_logged');

      revalidatePath(`/dashboard/deals/${deal.id}`);
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* ------------------------------------------------------------------ */
/* Inline deal-field edits: Next Step / Competitor / Source            */
/* ------------------------------------------------------------------ */

const dealFieldSchema = z.object({
  dealId: z.uuid({ message: 'Invalid deal id' }),
  field: z.enum(['nextStep', 'competitor', 'source']),
  value: z.string().max(2000).nullable(),
});

export type UpdateDealFieldResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Single-field inline update for the freeform deal-info fields (Next Step,
 * Competitor, Source). Kept separate from the heavyweight edit-deal form so a
 * one-field tweak doesn't ship the whole payload.
 */
export async function updateDealFieldAction(
  input: unknown,
): Promise<UpdateDealFieldResult> {
  const parsed = dealFieldSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid field update.' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const value = parsed.data.value?.trim() ? parsed.data.value.trim() : null;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const patch: Partial<
        Record<'nextStep' | 'competitor' | 'source', string | null>
      > = { [parsed.data.field]: value };

      const updated = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(deals)
          .set({ ...patch, updatedBy: membership.userId })
          .where(
            and(
              eq(deals.id, parsed.data.dealId),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .returning({
            nextStep: deals.nextStep,
            competitor: deals.competitor,
            source: deals.source,
            name: deals.name,
          });
        if (!row) return null;

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: parsed.data.dealId,
          action: 'updated',
          metadata: {
            name: row.name,
            field: parsed.data.field,
          },
        });
        return row;
      });

      if (!updated) return { ok: false, message: 'Deal not found in this tenant.' };

      // Next Step is a scoring signal; recompute on any of these field edits.
      await queueDealScoreRecompute(tenant.id, parsed.data.dealId, 'field_edit');

      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true, value };
    },
  );
}
