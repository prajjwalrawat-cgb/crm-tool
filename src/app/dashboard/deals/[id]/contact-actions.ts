'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { contacts, dealContacts, deals } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';

const ROLES = [
  'decision_maker',
  'influencer',
  'champion',
  'blocker',
  'other',
] as const;

export type DealContactResult =
  | { ok: true }
  | { ok: false; message: string };

/** Cross-tenant guard: the deal exists and belongs to the active tenant. */
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
  contactId: z.uuid(),
  role: z.enum(ROLES).default('other'),
  isPrimary: z.boolean().optional(),
});

/** Link an existing contact to the deal. */
export async function addDealContactAction(
  input: unknown,
): Promise<DealContactResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const deal = await dealInTenant(tenant.id, parsed.data.dealId);
      if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

      // Confirm the contact is in this tenant (RLS also masks, but be explicit).
      const [contact] = await tenantTransaction(async (tx) =>
        tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, parsed.data.contactId),
              eq(contacts.tenantId, tenant.id),
              isNull(contacts.deletedAt),
            ),
          )
          .limit(1),
      );
      if (!contact) return { ok: false, message: 'Contact not found.' };

      try {
        await tenantTransaction(async (tx) => {
          // First stakeholder on the deal becomes primary automatically.
          const existing = await tx
            .select({ id: dealContacts.id })
            .from(dealContacts)
            .where(
              and(
                eq(dealContacts.tenantId, tenant.id),
                eq(dealContacts.dealId, parsed.data.dealId),
              ),
            );
          const makePrimary = parsed.data.isPrimary || existing.length === 0;
          if (makePrimary) {
            await tx
              .update(dealContacts)
              .set({ isPrimary: false })
              .where(
                and(
                  eq(dealContacts.tenantId, tenant.id),
                  eq(dealContacts.dealId, parsed.data.dealId),
                ),
              );
          }
          await tx.insert(dealContacts).values({
            tenantId: tenant.id,
            dealId: parsed.data.dealId,
            contactId: parsed.data.contactId,
            role: parsed.data.role,
            isPrimary: makePrimary,
          });
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: parsed.data.dealId,
            action: 'updated',
            metadata: { name: deal.name, field: 'stakeholder', op: 'added' },
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate') || msg.includes('unique')) {
          return { ok: false, message: 'That contact is already on this deal.' };
        }
        throw err;
      }

      await queueDealScoreRecompute(tenant.id, parsed.data.dealId, 'stakeholder_added');
      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true };
    },
  );
}

const createSchema = z.object({
  dealId: z.uuid(),
  firstName: z.string().max(120).optional().nullable(),
  lastName: z.string().max(120).optional().nullable(),
  email: z.string().email('Enter a valid email').max(255).optional().or(z.literal('')),
  phone: z.string().max(60).optional().nullable(),
  title: z.string().max(160).optional().nullable(),
  role: z.enum(ROLES).default('other'),
});

/** Create a brand-new contact inline and link it to the deal. */
export async function createAndLinkContactAction(
  input: unknown,
): Promise<DealContactResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: 'Please provide a name or email.' };
  }
  const { firstName, lastName, email } = parsed.data;
  if (!firstName?.trim() && !lastName?.trim() && !email?.trim()) {
    return { ok: false, message: 'Provide at least a name or email.' };
  }

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const deal = await dealInTenant(tenant.id, parsed.data.dealId);
      if (!deal) return { ok: false, message: 'Deal not found in this tenant.' };

      await tenantTransaction(async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({
            tenantId: tenant.id,
            firstName: firstName?.trim() || null,
            lastName: lastName?.trim() || null,
            email: email?.trim() || null,
            phone: parsed.data.phone?.trim() || null,
            title: parsed.data.title?.trim() || null,
            ownerId: membership.userId,
            updatedBy: membership.userId,
          })
          .returning({ id: contacts.id });
        if (!contact) throw new Error('Failed to create contact');

        const existing = await tx
          .select({ id: dealContacts.id })
          .from(dealContacts)
          .where(
            and(
              eq(dealContacts.tenantId, tenant.id),
              eq(dealContacts.dealId, parsed.data.dealId),
            ),
          );
        const makePrimary = existing.length === 0;

        await tx.insert(dealContacts).values({
          tenantId: tenant.id,
          dealId: parsed.data.dealId,
          contactId: contact.id,
          role: parsed.data.role,
          isPrimary: makePrimary,
        });
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: parsed.data.dealId,
          action: 'updated',
          metadata: { name: deal.name, field: 'stakeholder', op: 'created' },
        });
      });

      await queueDealScoreRecompute(tenant.id, parsed.data.dealId, 'stakeholder_added');
      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      revalidatePath('/dashboard/contacts');
      return { ok: true };
    },
  );
}

const roleSchema = z.object({
  id: z.uuid(),
  dealId: z.uuid(),
  role: z.enum(ROLES),
});

export async function updateDealContactRoleAction(
  input: unknown,
): Promise<DealContactResult> {
  const parsed = roleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await tenantTransaction(async (tx) => {
        await tx
          .update(dealContacts)
          .set({ role: parsed.data.role })
          .where(
            and(
              eq(dealContacts.id, parsed.data.id),
              eq(dealContacts.tenantId, tenant.id),
            ),
          );
      });
      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true };
    },
  );
}

const primarySchema = z.object({ id: z.uuid(), dealId: z.uuid() });

/** Make one stakeholder the primary, clearing any other primary on the deal. */
export async function setPrimaryDealContactAction(
  input: unknown,
): Promise<DealContactResult> {
  const parsed = primarySchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await tenantTransaction(async (tx) => {
        // Clear existing primary first so the partial-unique index never trips.
        await tx
          .update(dealContacts)
          .set({ isPrimary: false })
          .where(
            and(
              eq(dealContacts.tenantId, tenant.id),
              eq(dealContacts.dealId, parsed.data.dealId),
            ),
          );
        await tx
          .update(dealContacts)
          .set({ isPrimary: true })
          .where(
            and(
              eq(dealContacts.id, parsed.data.id),
              eq(dealContacts.tenantId, tenant.id),
            ),
          );
      });
      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true };
    },
  );
}

const removeSchema = z.object({ id: z.uuid(), dealId: z.uuid() });

export async function removeDealContactAction(
  input: unknown,
): Promise<DealContactResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid input.' };

  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      await tenantTransaction(async (tx) => {
        const [removed] = await tx
          .delete(dealContacts)
          .where(
            and(
              eq(dealContacts.id, parsed.data.id),
              eq(dealContacts.tenantId, tenant.id),
            ),
          )
          .returning({ isPrimary: dealContacts.isPrimary });
        // If we removed the primary, promote the next stakeholder (if any) so
        // the deal always has a primary when it has stakeholders.
        if (removed?.isPrimary) {
          const [next] = await tx
            .select({ id: dealContacts.id })
            .from(dealContacts)
            .where(
              and(
                eq(dealContacts.tenantId, tenant.id),
                eq(dealContacts.dealId, parsed.data.dealId),
              ),
            )
            .limit(1);
          if (next) {
            await tx
              .update(dealContacts)
              .set({ isPrimary: true })
              .where(eq(dealContacts.id, next.id));
          }
        }
      });
      await queueDealScoreRecompute(tenant.id, parsed.data.dealId, 'stakeholder_removed');
      revalidatePath(`/dashboard/deals/${parsed.data.dealId}`);
      return { ok: true };
    },
  );
}
