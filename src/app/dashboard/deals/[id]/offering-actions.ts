'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { dealOfferings, deals } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import {
  clearDealPrimary,
  countDealOfferings,
  resolveOfferingIds,
} from '@/lib/offerings/queries';
import { OFFERINGS_CANNOT_EMPTY_MESSAGE } from '@/lib/offerings/types';

export type DealOfferingResult = { ok: true } | { ok: false; message: string };

/**
 * Tagging is gated on `manageDeals`, NOT `manageOfferings`. A rep must be
 * able to say what their own deal is selling; only an admin may change the
 * catalog those tags point at.
 */
const PERMISSION = 'manageDeals' as const;

/** Cross-tenant guard, mirroring `contact-actions.ts`. */
async function dealInTenant(
  tenantId: string,
  dealId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await tenantTransaction(async (tx) =>
    tx
      .select({ id: deals.id, name: deals.name })
      .from(deals)
      .where(
        and(
          eq(deals.id, dealId),
          eq(deals.tenantId, tenantId),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

const addSchema = z.object({
  dealId: z.uuid(),
  offeringId: z.uuid(),
});

/**
 * Tag an offering onto an existing deal.
 *
 * The first tag on a deal becomes primary automatically — the same rule the
 * create form applies, and the reason an untagged legacy deal can be brought
 * fully up to date in one click rather than two.
 */
export async function addDealOfferingAction(
  input: unknown,
): Promise<DealOfferingResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission(PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const deal = await dealInTenant(tenant.id, parsed.data.dealId);
      if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

      try {
        await tenantTransaction(async (tx) => {
          // activeOnly: a retired offering can stay on the deals that already
          // carry it, but must never be added to another one.
          const [offeringId] = await resolveOfferingIds(
            tx,
            tenant.id,
            [parsed.data.offeringId],
            { activeOnly: true },
          );
          if (!offeringId) {
            throw new UnavailableOfferingError(
              'That offering is no longer available.',
            );
          }

          const existing = await countDealOfferings(
            tx,
            tenant.id,
            parsed.data.dealId,
          );
          await tx.insert(dealOfferings).values({
            tenantId: tenant.id,
            dealId: parsed.data.dealId,
            offeringId,
            isPrimary: existing === 0,
          });
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: parsed.data.dealId,
            action: 'updated',
            metadata: { name: deal.name, field: 'offering', op: 'added' },
          });
        });
      } catch (err) {
        if (err instanceof UnavailableOfferingError) {
          return { ok: false, message: err.message };
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate') || msg.includes('unique')) {
          return { ok: false, message: 'That offering is already on this deal.' };
        }
        throw err;
      }

      revalidateDeal(parsed.data.dealId);
      return { ok: true };
    },
  );
}

class UnavailableOfferingError extends Error {}

const primarySchema = z.object({ id: z.uuid(), dealId: z.uuid() });

/**
 * Make one tag the primary, clearing whatever held it before.
 *
 * The clear MUST happen first and in the same transaction: the partial unique
 * index on `(deal_id) WHERE is_primary` rejects the instant a second `true`
 * exists, so a set-then-clear ordering fails on every deal that already has a
 * primary — that is, on every deal this action is ever called for.
 */
export async function setPrimaryDealOfferingAction(
  input: unknown,
): Promise<DealOfferingResult> {
  const parsed = primarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission(PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const updated = await tenantTransaction(async (tx) => {
        await clearDealPrimary(tx, tenant.id, parsed.data.dealId);
        const [row] = await tx
          .update(dealOfferings)
          .set({ isPrimary: true })
          .where(
            and(
              eq(dealOfferings.id, parsed.data.id),
              eq(dealOfferings.tenantId, tenant.id),
              eq(dealOfferings.dealId, parsed.data.dealId),
            ),
          )
          .returning({ id: dealOfferings.id });
        return Boolean(row);
      });
      if (!updated) return { ok: false, message: 'Offering tag not found.' };
      revalidateDeal(parsed.data.dealId);
      return { ok: true };
    },
  );
}

const removeSchema = z.object({ id: z.uuid(), dealId: z.uuid() });

/**
 * Untag an offering.
 *
 * Removing the primary promotes the next remaining tag, so a deal never sits
 * in the "has tags, none primary" state the deals column has no way to
 * render.
 *
 * Removing the LAST tag is REFUSED. A deal that has been tagged may not
 * become untagged — otherwise the mandatory-on-create rule means nothing: a
 * deal created under it could be reopened and stripped one tag at a time back
 * into the exact state creation refused to produce. Only deals that were
 * never tagged (the legacy backlog) are allowed to sit Uncategorized.
 *
 * This does not trap a mistagged deal, which was the original and wrong
 * reason for allowing it: the fix is to add the correct offering and then
 * remove the wrong one, and the message says exactly that. The card also
 * disables the button on a lone tag, so the refusal is normally unreachable —
 * this is the backstop for a stale tab.
 */
export async function removeDealOfferingAction(
  input: unknown,
): Promise<DealOfferingResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission(PERMISSION);
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const refusal = await tenantTransaction(async (tx) => {
        // Count BEFORE deleting: "is this the last one" cannot be asked after
        // the row is gone, and asking outside the transaction would race a
        // concurrent remove into leaving the deal untagged.
        const remaining = await countDealOfferings(
          tx,
          tenant.id,
          parsed.data.dealId,
        );
        if (remaining <= 1) return OFFERINGS_CANNOT_EMPTY_MESSAGE;

        const [removed] = await tx
          .delete(dealOfferings)
          .where(
            and(
              eq(dealOfferings.id, parsed.data.id),
              eq(dealOfferings.tenantId, tenant.id),
              eq(dealOfferings.dealId, parsed.data.dealId),
            ),
          )
          .returning({ isPrimary: dealOfferings.isPrimary });
        if (removed?.isPrimary) {
          const [next] = await tx
            .select({ id: dealOfferings.id })
            .from(dealOfferings)
            .where(
              and(
                eq(dealOfferings.tenantId, tenant.id),
                eq(dealOfferings.dealId, parsed.data.dealId),
              ),
            )
            .limit(1);
          if (next) {
            await tx
              .update(dealOfferings)
              .set({ isPrimary: true })
              .where(eq(dealOfferings.id, next.id));
          }
        }
        return null;
      });
      if (refusal) return { ok: false, message: refusal };
      revalidateDeal(parsed.data.dealId);
      return { ok: true };
    },
  );
}

function revalidateDeal(dealId: string): void {
  revalidatePath(`/dashboard/deals/${dealId}`);
  // The list's Offering column and the Uncategorized filter both change the
  // moment a deal is tagged, so refreshing only the detail page would leave
  // the backlog list still showing a deal that has just been worked.
  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/deals/board');
}
