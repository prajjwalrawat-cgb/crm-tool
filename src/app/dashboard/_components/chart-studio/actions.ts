'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { chartViews } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

import {
  CHART_KEY_REVENUE_TREND,
  parseRevenueTrendConfig,
  REVENUE_TREND_VARIANTS,
} from '@/lib/chart-studio/config';

/**
 * Save (upsert) the user's default view for a chart. Persisted in
 * the `chart_views` table; one default per (tenant, user, chart_key)
 * — enforced via a partial unique index.
 *
 * RBAC:
 *   roleScope='user'   — any persona (member/manager/admin)
 *   roleScope='team'   — manager + admin only
 *   roleScope='tenant' — admin only
 *
 * The variant + display config are validated via the chart-specific
 * parser; anything unrecognized falls back to the safe default.
 */

const saveSchema = z.object({
  chartKey: z.literal(CHART_KEY_REVENUE_TREND),
  variant: z.enum(REVENUE_TREND_VARIANTS.map((v) => v.value) as [
    string,
    ...string[],
  ]),
  display: z.object({
    showLegend: z.boolean(),
    smoothLines: z.boolean(),
    animated: z.boolean(),
    showLostLine: z.boolean(),
    compact: z.boolean(),
    cumulative: z.boolean(),
  }),
  title: z.string().trim().max(80).nullable().optional(),
  roleScope: z.enum(['user', 'team', 'tenant']).default('user'),
});

type SaveInput = z.infer<typeof saveSchema>;

type ActionResult =
  | { ok: true }
  | { ok: false; message: string };

export async function saveChartViewAction(
  input: SaveInput,
): Promise<ActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Invalid chart configuration.',
    };
  }
  const data = parsed.data;

  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const persona = personaOf(membership.role);

    // Persona ↔ scope guard.
    if (data.roleScope === 'team' && persona !== 'manager' && persona !== 'admin') {
      return {
        ok: false,
        message: 'Only managers and admins can save team-scoped views.',
      };
    }
    if (data.roleScope === 'tenant' && persona !== 'admin') {
      return {
        ok: false,
        message: 'Only admins can save organization-wide views.',
      };
    }

    // Re-parse to drop any extra keys the client might have sent.
    const safeConfig = parseRevenueTrendConfig({
      variant: data.variant,
      display: data.display,
    });

    await tenantTransaction(async (tx) => {
      // Upsert the user's default by clearing-then-inserting. We don't
      // use ON CONFLICT here because there's no single PK we can target
      // (the table allows multiple non-default rows per chart_key); a
      // delete-then-insert keeps the logic obvious without sacrificing
      // anything — both queries are tiny.
      await tx
        .delete(chartViews)
        .where(
          and(
            eq(chartViews.tenantId, tenant.id),
            eq(chartViews.userId, userId),
            eq(chartViews.chartKey, data.chartKey),
            eq(chartViews.isDefault, true),
          ),
        );
      await tx.insert(chartViews).values({
        tenantId: tenant.id,
        userId,
        chartKey: data.chartKey,
        title: data.title ?? null,
        roleScope: data.roleScope,
        config: safeConfig,
        isDefault: true,
      });
    });

    // The chart re-reads its config on next dashboard render.
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/my-performance');
    return { ok: true };
  });
}

const resetSchema = z.object({
  chartKey: z.literal(CHART_KEY_REVENUE_TREND),
});

export async function resetChartViewAction(input: {
  chartKey: string;
}): Promise<ActionResult> {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Invalid chart key.' };
  }

  return await withTenantSession(async ({ tenant, userId }) => {
    await tenantTransaction(async (tx) => {
      await tx
        .delete(chartViews)
        .where(
          and(
            eq(chartViews.tenantId, tenant.id),
            eq(chartViews.userId, userId),
            eq(chartViews.chartKey, parsed.data.chartKey),
            eq(chartViews.isDefault, true),
          ),
        );
    });
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/my-performance');
    return { ok: true };
  });
}
