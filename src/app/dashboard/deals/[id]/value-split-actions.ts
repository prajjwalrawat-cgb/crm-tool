'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { deals } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import {
  BILLING_TYPES,
  MAX_CONTRACT_YEARS,
  MAX_ELEMENTS,
  type SplitRow,
  VALUE_COMPONENTS,
  validateSplit,
} from '@/lib/deals/value-split';
import { replaceDealValueSplit } from '@/lib/deals/value-split-queries';

/* -------- MULTI-YEAR CONTRACT VALUE SPLIT -------- */

// One cell of the (element x year) grid.
const rowSchema = z.object({
  elementIndex: z.coerce.number().int().min(1).max(MAX_ELEMENTS),
  component: z.enum(VALUE_COMPONENTS),
  // Only meaningful for `other`; validateSplit requires it to be non-empty
  // there and ignores it elsewhere.
  componentLabel: z.string().trim().max(60).nullish(),
  billingType: z.enum(BILLING_TYPES),
  yearIndex: z.coerce.number().int().min(1).max(MAX_CONTRACT_YEARS),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date'),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date'),
  // Minor units — the client converts from the major-unit inputs.
  amountMinor: z.coerce.number().int().min(0),
});

const saveSchema = z.object({
  dealId: z.uuid({ message: 'Invalid deal id' }),
  // A full grid, so the cap is elements x years rather than either alone.
  rows: z.array(rowSchema).max(MAX_ELEMENTS * MAX_CONTRACT_YEARS),
});

export type SaveValueSplitResult =
  | { ok: true; cleared: boolean }
  | { ok: false; message: string; differenceMinor?: number };

/**
 * Record (or clear) a deal's per-contract-year value split.
 *
 * The split must account for the deal's amount exactly — it describes how the
 * TCV is spread, so a set of rows that doesn't add up to it would be a claim
 * about money that isn't there. An empty `rows` array clears the split, which
 * is how a deal goes back to being a single-year value.
 *
 * `deals.amount_minor` is never written here: the split is record-and-report
 * only, so the board, forecast and targets keep reading the same TCV they read
 * before the split existed.
 */
export async function saveDealValueSplitAction(
  input: unknown,
): Promise<SaveValueSplitResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message:
        flat.formErrors[0] ??
        Object.values(flat.fieldErrors).flat()[0] ??
        'Check the breakdown and try again.',
    };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const rows: SplitRow[] = parsed.data.rows;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const outcome = await tenantTransaction(async (tx) => {
        const [deal] = await tx
          .select({
            id: deals.id,
            name: deals.name,
            amountMinor: deals.amountMinor,
            currency: deals.currency,
          })
          .from(deals)
          .where(
            and(
              eq(deals.id, parsed.data.dealId),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1);
        if (!deal) return { notFound: true as const };

        // Clearing is always allowed — there's nothing to reconcile.
        if (rows.length > 0) {
          const check = validateSplit(rows, deal.amountMinor);
          if (!check.ok) {
            return {
              invalid: {
                message: check.message,
                differenceMinor: check.differenceMinor,
              },
            };
          }
        }

        await replaceDealValueSplit(tx, {
          tenantId: tenant.id,
          dealId: deal.id,
          rows,
        });

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: deal.id,
          action: 'value_split_changed',
          metadata: {
            name: deal.name,
            // `rows` is now a grid, so count the distinct dimensions rather
            // than the cell count.
            years: new Set(rows.map((r) => r.yearIndex)).size,
            elements: new Set(rows.map((r) => r.elementIndex)).size,
            startISO: rows[0]?.periodStart ?? null,
            totalMinor: deal.amountMinor,
            currency: deal.currency,
          },
        });

        return { cleared: rows.length === 0 };
      });

      if ('notFound' in outcome && outcome.notFound) {
        return { ok: false, message: 'Deal not found in this tenant.' };
      }
      if ('invalid' in outcome && outcome.invalid) {
        return {
          ok: false,
          message: outcome.invalid.message,
          differenceMinor: outcome.invalid.differenceMinor,
        };
      }

      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      revalidatePath('/dashboard/activity');
      return { ok: true, cleared: outcome.cleared };
    },
  );
}
