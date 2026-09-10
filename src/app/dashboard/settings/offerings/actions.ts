'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext } from '@/lib/db-context';
import {
  createOffering,
  DuplicateOfferingError,
  reorderOfferings,
  setOfferingActive,
  updateOffering,
} from '@/lib/offerings/queries';
import { OFFERING_CATEGORIES } from '@/lib/offerings/types';

export type OfferingSettingsResult = { ok: true } | { ok: false; message: string };

/**
 * Paths whose rendered output depends on the catalog. The picker on the deals
 * page, the chips in the table, the funnel's offering dropdown and the
 * per-deal card all read it, so a rename that only refreshed Settings would
 * leave the old name on screen everywhere the name actually matters.
 *
 * The deal DETAIL pages are not listed — there is one per deal and they can't
 * be enumerated. They pick the change up on their next render, which is the
 * same freshness the rest of the app's linked-record names have.
 */
function revalidateOfferingConsumers(): void {
  revalidatePath('/dashboard/settings/offerings');
  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/deals/board');
  revalidatePath('/dashboard/reports/funnel-by-offering');
}

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Give the offering a name')
  .max(120, 'Keep the name under 120 characters');

const createSchema = z.object({
  name: nameSchema,
  category: z.enum(OFFERING_CATEGORIES, { message: 'Pick Product or Service' }),
});

export async function createOfferingAction(
  input: unknown,
): Promise<OfferingSettingsResult> {
  const gate = await checkPermission('manageOfferings');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid offering.',
    };
  }

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      try {
        await createOffering({
          tenantId: tenant.id,
          name: parsed.data.name,
          category: parsed.data.category,
        });
      } catch (err) {
        // A duplicate is a user mistake with an obvious fix, not a 500. The
        // unique index is case-insensitive, so this also catches "safeops360"
        // typed against an existing "SafeOps360" — which is the collision
        // that would quietly split one product's funnel in two.
        if (err instanceof DuplicateOfferingError) {
          return { ok: false, message: err.message };
        }
        throw err;
      }
      revalidateOfferingConsumers();
      return { ok: true };
    },
  );
}

const updateSchema = createSchema.extend({
  id: z.uuid({ message: 'Invalid offering id' }),
});

export async function updateOfferingAction(
  input: unknown,
): Promise<OfferingSettingsResult> {
  const gate = await checkPermission('manageOfferings');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid offering.',
    };
  }

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      try {
        const row = await updateOffering({
          tenantId: tenant.id,
          id: parsed.data.id,
          name: parsed.data.name,
          category: parsed.data.category,
        });
        if (!row) return { ok: false, message: 'Offering not found.' };
      } catch (err) {
        if (err instanceof DuplicateOfferingError) {
          return { ok: false, message: err.message };
        }
        throw err;
      }
      revalidateOfferingConsumers();
      return { ok: true };
    },
  );
}

const activeSchema = z.object({
  id: z.uuid({ message: 'Invalid offering id' }),
  active: z.boolean(),
});

/**
 * Retire or restore an offering. There is no delete action in this file, and
 * that is the feature, not an omission: historical deals reference these
 * rows, the FK refuses to orphan a tag, and a retired offering must keep
 * rendering on the deals that carry it. Deactivating removes it from the tag
 * picker for NEW tags and from nothing else.
 */
export async function setOfferingActiveAction(
  input: unknown,
): Promise<OfferingSettingsResult> {
  const gate = await checkPermission('manageOfferings');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = activeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid offering.' };

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const row = await setOfferingActive(
        tenant.id,
        parsed.data.id,
        parsed.data.active,
      );
      if (!row) return { ok: false, message: 'Offering not found.' };
      revalidateOfferingConsumers();
      return { ok: true };
    },
  );
}

const reorderSchema = z.object({
  category: z.enum(OFFERING_CATEGORIES),
  orderedIds: z.array(z.uuid()).min(1).max(200),
});

/**
 * Takes the WHOLE category in its new order, not a "move this one up". See
 * `reorderOfferings` for why: a two-row swap applied against a stale page
 * moves the wrong pair, whereas rewriting the list the admin was looking at
 * either applies exactly what they saw or no-ops on ids that have moved on.
 */
export async function reorderOfferingsAction(
  input: unknown,
): Promise<OfferingSettingsResult> {
  const gate = await checkPermission('manageOfferings');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid ordering.' };

  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await reorderOfferings(
        tenant.id,
        parsed.data.category,
        parsed.data.orderedIds,
      );
      revalidateOfferingConsumers();
      return { ok: true };
    },
  );
}
