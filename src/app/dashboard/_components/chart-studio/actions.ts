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
  CHART_KEY_STAGE_CONVERSION,
  CHART_KEY_STAGE_DONUT,
  parseRevenueTrendConfig,
  parseStageConversionConfig,
  parseStageDonutConfig,
} from '@/lib/chart-studio/config';

/**
 * Save / reset chart-view actions. Generalized over chart keys: each
 * key has its own config validator (re-using the chart-studio
 * parsers) so an unrecognized config is normalized rather than
 * stored verbatim.
 */

const SUPPORTED_CHART_KEYS = [
  CHART_KEY_REVENUE_TREND,
  CHART_KEY_STAGE_CONVERSION,
  CHART_KEY_STAGE_DONUT,
] as const;

const saveSchema = z.object({
  chartKey: z.enum(SUPPORTED_CHART_KEYS),
  // The full config blob is validated by the chart-specific parser
  // below — we leave it loose at the schema layer.
  config: z.record(z.string(), z.unknown()),
  title: z.string().trim().max(80).nullable().optional(),
  roleScope: z.enum(['user', 'team', 'tenant']).default('user'),
});

type SaveInput = z.infer<typeof saveSchema>;

type ActionResult =
  | { ok: true }
  | { ok: false; message: string };

function parseConfigForKey(
  chartKey: (typeof SUPPORTED_CHART_KEYS)[number],
  raw: unknown,
): unknown {
  switch (chartKey) {
    case CHART_KEY_REVENUE_TREND:
      return parseRevenueTrendConfig(raw);
    case CHART_KEY_STAGE_CONVERSION:
      return parseStageConversionConfig(raw);
    case CHART_KEY_STAGE_DONUT:
      return parseStageDonutConfig(raw);
  }
}

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

    const safeConfig = parseConfigForKey(data.chartKey, data.config);

    await tenantTransaction(async (tx) => {
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
        config: safeConfig as object,
        isDefault: true,
      });
    });

    revalidatePath('/dashboard');
    revalidatePath('/dashboard/my-performance');
    return { ok: true };
  });
}

const resetSchema = z.object({
  chartKey: z.enum(SUPPORTED_CHART_KEYS),
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
