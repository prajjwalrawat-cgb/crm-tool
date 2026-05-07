'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db';
import { companies, contacts, type Contact } from '@/db/schema';
import { checkPermission } from '@/lib/auth-guard';
import { createContactSchema } from '@/lib/contacts/schema';

export type CreateContactResult =
  | { ok: true; contact: Contact }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export async function createContactAction(
  formData: FormData,
): Promise<CreateContactResult> {
  const gate = await checkPermission('manageContacts');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant } = gate;

  const raw: Record<string, FormDataEntryValue | null> = {
    firstName: formData.get('firstName'),
    lastName: formData.get('lastName'),
    email: formData.get('email'),
    phone: formData.get('phone'),
    title: formData.get('title'),
    companyId: formData.get('companyId'),
  };
  // FormData yields '' for empty inputs; treat all blanks as null.
  for (const key of Object.keys(raw)) {
    if (typeof raw[key] === 'string' && raw[key].trim() === '') {
      raw[key] = null;
    }
  }

  const parsed = createContactSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const formErrors = flat.formErrors;
    return {
      ok: false,
      message: formErrors[0] ?? 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  // Defense in depth: ensure the picked company belongs to this tenant.
  // The FK alone wouldn't catch a cross-tenant id from a tampered form.
  if (parsed.data.companyId) {
    const [company] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.id, parsed.data.companyId),
          eq(companies.tenantId, tenant.id),
        ),
      )
      .limit(1);
    if (!company) {
      return {
        ok: false,
        message: 'The selected company is not in this tenant.',
        fieldErrors: { companyId: ['Pick a company from the list'] },
      };
    }
  }

  const [created] = await db
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

  if (!created) {
    return { ok: false, message: 'Failed to create contact.' };
  }

  revalidatePath('/dashboard/contacts');
  return { ok: true, contact: created };
}
