'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { companies, contacts, type Contact } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { recordNotification } from '@/lib/notifications/recorder';
import {
  contactIdSchema,
  createContactSchema,
  updateContactSchema,
} from '@/lib/contacts/schema';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { serializeContact } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

export type CreateContactResult =
  | { ok: true; contact: Contact }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type UpdateContactResult = CreateContactResult;

export type SimpleResult =
  | { ok: true }
  | { ok: false; message: string };

function contactDisplayName(c: Contact): string {
  const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
  if (parts.length) return parts.join(' ');
  return c.email ?? c.id;
}

/**
 * Cross-tenant FK check, run inside the active tenant context. RLS would
 * already mask other tenants' rows, but the explicit `tenant_id =` guard
 * is the secondary defense kept for visibility in audit reads of the code.
 */
async function assertCompanyInTenant(
  tenantId: string,
  companyId: string,
): Promise<boolean> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.id, companyId),
          eq(companies.tenantId, tenantId),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/* -------- CREATE -------- */

export async function createContactAction(
  formData: FormData,
): Promise<CreateContactResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw: Record<string, FormDataEntryValue | null> = {
        firstName: formData.get('firstName'),
        lastName: formData.get('lastName'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        title: formData.get('title'),
        companyId: formData.get('companyId'),
      };
      for (const key of Object.keys(raw)) {
        if (typeof raw[key] === 'string' && raw[key].trim() === '') raw[key] = null;
      }

      const parsed = createContactSchema.safeParse(raw);
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      if (
        parsed.data.companyId &&
        !(await assertCompanyInTenant(tenant.id, parsed.data.companyId))
      ) {
        return {
          ok: false,
          message: 'The selected company is not in this tenant.',
          fieldErrors: { companyId: ['Pick a company from the list'] },
        };
      }

      const created = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(contacts)
          .values({
            tenantId: tenant.id,
            companyId: parsed.data.companyId,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            email: parsed.data.email,
            phone: parsed.data.phone,
            title: parsed.data.title,
          })
          .returning();
        if (!row) return null;
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'contact',
          entityId: row.id,
          action: 'created',
          metadata: { name: contactDisplayName(row) },
        });
        await publishRealtimeEvent(tx, {
          type: 'contact.created',
          tenantId: tenant.id,
          contact: serializeContact(row),
        });
        return row;
      });

      if (!created) return { ok: false, message: 'Failed to create contact.' };

      await sendWorkflowEvent('crm/contact.created', {
        tenantId: tenant.id,
        contactId: created.id,
        actorUserId: membership.userId,
        displayName: contactDisplayName(created),
      });
      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'contact',
        entityId: created.id,
        actorUserId: membership.userId,
        reason: 'created',
      });

      revalidatePath('/dashboard/contacts');
      revalidatePath('/dashboard/activity');
      revalidatePath('/dashboard');
      return { ok: true, contact: created };
    },
  );
}

/* -------- UPDATE -------- */

export async function updateContactAction(
  formData: FormData,
): Promise<UpdateContactResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw: Record<string, FormDataEntryValue | null> = {
        id: formData.get('id'),
        firstName: formData.get('firstName'),
        lastName: formData.get('lastName'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        title: formData.get('title'),
        companyId: formData.get('companyId'),
      };
      for (const key of Object.keys(raw)) {
        if (key === 'id') continue;
        if (typeof raw[key] === 'string' && raw[key].trim() === '') raw[key] = null;
      }

      const parsed = updateContactSchema.safeParse(raw);
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      if (
        parsed.data.companyId &&
        !(await assertCompanyInTenant(tenant.id, parsed.data.companyId))
      ) {
        return {
          ok: false,
          message: 'The selected company is not in this tenant.',
          fieldErrors: { companyId: ['Pick a company from the list'] },
        };
      }

      const updated = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(contacts)
          .set({
            companyId: parsed.data.companyId,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            email: parsed.data.email,
            phone: parsed.data.phone,
            title: parsed.data.title,
          })
          .where(
            and(
              eq(contacts.id, parsed.data.id),
              eq(contacts.tenantId, tenant.id),
              isNull(contacts.deletedAt),
            ),
          )
          .returning();
        if (!row) return null;
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'contact',
          entityId: row.id,
          action: 'updated',
          metadata: { name: contactDisplayName(row) },
        });
        await publishRealtimeEvent(tx, {
          type: 'contact.updated',
          tenantId: tenant.id,
          contact: serializeContact(row),
        });
        return row;
      });

      if (!updated) {
        return { ok: false, message: 'Contact not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'contact',
        entityId: updated.id,
        actorUserId: membership.userId,
        reason: 'updated',
      });

      revalidatePath('/dashboard/contacts');
      revalidatePath('/dashboard/activity');
      return { ok: true, contact: updated };
    },
  );
}

/* -------- SOFT DELETE -------- */

export async function softDeleteContactAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  // See companies/actions.ts → softDeleteCompanyAction for the
  // includeDeleted rationale: PG enforces the SELECT USING as a
  // WITH CHECK on UPDATE...RETURNING's new row.
  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = contactIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid contact id.' };

      const deleted = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(contacts)
          .set({ deletedAt: new Date(), deletedBy: membership.userId })
          .where(
            and(
              eq(contacts.id, idCheck.data.id),
              eq(contacts.tenantId, tenant.id),
              isNull(contacts.deletedAt),
            ),
          )
          .returning();
        if (!row) return null;
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'contact',
          entityId: row.id,
          action: 'deleted',
          metadata: { name: contactDisplayName(row) },
        });
        await publishRealtimeEvent(tx, {
          type: 'contact.deleted',
          tenantId: tenant.id,
          contactId: row.id,
          name: contactDisplayName(row),
        });
        return row;
      });

      if (!deleted) {
        return { ok: false, message: 'Contact not found or already deleted.' };
      }

      revalidatePath('/dashboard/contacts');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- HARD DELETE (permanent) -------- */

export async function hardDeleteContactAction(
  id: string,
): Promise<SimpleResult> {
  const gate = await checkPermission('hardDeleteContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = contactIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid contact id.' };

      const removed = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .delete(contacts)
          .where(
            and(
              eq(contacts.id, idCheck.data.id),
              eq(contacts.tenantId, tenant.id),
            ),
          )
          .returning();
        return row ?? null;
      });

      if (!removed) {
        return { ok: false, message: 'Contact not found in this tenant.' };
      }

      revalidatePath('/dashboard/contacts');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- RESTORE -------- */

export async function restoreContactAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = contactIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid contact id.' };

      const restored = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(contacts)
          .set({ deletedAt: null, deletedBy: null })
          .where(
            and(
              eq(contacts.id, idCheck.data.id),
              eq(contacts.tenantId, tenant.id),
            ),
          )
          .returning();
        if (!row) return null;
        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'contact',
          entityId: row.id,
          action: 'restored',
          metadata: { name: contactDisplayName(row) },
        });
        await publishRealtimeEvent(tx, {
          type: 'contact.restored',
          tenantId: tenant.id,
          contact: serializeContact(row),
        });
        return row;
      });

      if (!restored) {
        return { ok: false, message: 'Contact not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'contact',
        entityId: restored.id,
        actorUserId: membership.userId,
        reason: 'restored',
      });

      revalidatePath('/dashboard/contacts');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- ASSIGN OWNER -------- */

const updateContactOwnerSchema = z.object({
  id: z.uuid({ message: 'Invalid contact id' }),
  ownerId: z.string().min(1).max(120).nullable(),
});

export type UpdateContactOwnerInput = {
  id: string;
  ownerId: string | null;
};

export type UpdateContactOwnerResult =
  | { ok: true; contact: Contact; changed: boolean }
  | { ok: false; message: string };

export async function updateContactOwnerAction(
  input: UpdateContactOwnerInput,
): Promise<UpdateContactOwnerResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = updateContactOwnerSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid owner payload' };
      }

      const result = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.id, parsed.data.id),
              eq(contacts.tenantId, tenant.id),
              isNull(contacts.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return { changed: false, contact: null as Contact | null };

        if ((previous.ownerId ?? null) === parsed.data.ownerId) {
          return { changed: false, contact: previous };
        }

        const [updated] = await tx
          .update(contacts)
          .set({ ownerId: parsed.data.ownerId })
          .where(eq(contacts.id, parsed.data.id))
          .returning();
        if (!updated) return { changed: false, contact: null as Contact | null };

        const displayName =
          [updated.firstName, updated.lastName].filter(Boolean).join(' ') ||
          updated.email ||
          'this contact';

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'contact',
          entityId: updated.id,
          action: 'owner_changed',
          metadata: {
            name: displayName,
            from: previous.ownerId ?? null,
            to: updated.ownerId ?? null,
          },
        });

        if (updated.ownerId) {
          await recordNotification(tx, {
            tenantId: tenant.id,
            recipientUserId: updated.ownerId,
            actorUserId: membership.userId,
            type: 'owner_changed',
            title: `You now own ${displayName}`,
            subtitle: 'Contact',
            entityType: 'contact',
            entityId: updated.id,
            metadata: { from: previous.ownerId ?? null },
          });
        }

        return { changed: true, contact: updated };
      });

      if (!result.contact) {
        return { ok: false, message: 'Contact not found' };
      }
      revalidatePath('/dashboard/contacts');
      revalidatePath(`/dashboard/contacts/${result.contact.id}`);
      return { ok: true, contact: result.contact, changed: result.changed };
    },
  );
}
