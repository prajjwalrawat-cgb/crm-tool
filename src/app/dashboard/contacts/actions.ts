'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { companies, contacts, type Contact } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  contactIdSchema,
  createContactSchema,
  updateContactSchema,
} from '@/lib/contacts/schema';

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

async function assertCompanyInTenant(
  tenantId: string,
  companyId: string,
): Promise<boolean> {
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.id, companyId),
        eq(companies.tenantId, tenantId),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(company);
}

/* -------- CREATE -------- */

export async function createContactAction(
  formData: FormData,
): Promise<CreateContactResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

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

  if (parsed.data.companyId && !(await assertCompanyInTenant(tenant.id, parsed.data.companyId))) {
    return {
      ok: false,
      message: 'The selected company is not in this tenant.',
      fieldErrors: { companyId: ['Pick a company from the list'] },
    };
  }

  const created = await db.transaction(async (tx) => {
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
    return row;
  });

  if (!created) return { ok: false, message: 'Failed to create contact.' };

  revalidatePath('/dashboard/contacts');
  revalidatePath('/dashboard/activity');
  revalidatePath('/dashboard');
  return { ok: true, contact: created };
}

/* -------- UPDATE -------- */

export async function updateContactAction(
  formData: FormData,
): Promise<UpdateContactResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

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

  if (parsed.data.companyId && !(await assertCompanyInTenant(tenant.id, parsed.data.companyId))) {
    return {
      ok: false,
      message: 'The selected company is not in this tenant.',
      fieldErrors: { companyId: ['Pick a company from the list'] },
    };
  }

  const updated = await db.transaction(async (tx) => {
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
    return row;
  });

  if (!updated) {
    return { ok: false, message: 'Contact not found in this tenant.' };
  }

  revalidatePath('/dashboard/contacts');
  revalidatePath('/dashboard/activity');
  return { ok: true, contact: updated };
}

/* -------- SOFT DELETE -------- */

export async function softDeleteContactAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = contactIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid contact id.' };

  const deleted = await db.transaction(async (tx) => {
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
    return row;
  });

  if (!deleted) {
    return { ok: false, message: 'Contact not found or already deleted.' };
  }

  revalidatePath('/dashboard/contacts');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- RESTORE -------- */

export async function restoreContactAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = contactIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid contact id.' };

  const restored = await db.transaction(async (tx) => {
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
    return row;
  });

  if (!restored) {
    return { ok: false, message: 'Contact not found in this tenant.' };
  }

  revalidatePath('/dashboard/contacts');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}
