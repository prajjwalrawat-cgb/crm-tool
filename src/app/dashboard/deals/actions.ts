'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { companies, contacts, deals, type Deal } from '@/db/schema';
import { toMinorUnits } from '@/lib/deals/currency';
import { createDealSchema } from '@/lib/deals/schema';
import { requireTenant } from '@/lib/tenant';

export type CreateDealResult =
  | { ok: true; deal: Deal }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export async function createDealAction(
  formData: FormData,
): Promise<CreateDealResult> {
  const tenant = await requireTenant();

  const raw: Record<string, FormDataEntryValue | null> = {
    name: formData.get('name'),
    stage: formData.get('stage'),
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    expectedCloseDate: formData.get('expectedCloseDate'),
    companyId: formData.get('companyId'),
    contactId: formData.get('contactId'),
  };
  for (const key of ['expectedCloseDate', 'companyId', 'contactId'] as const) {
    if (typeof raw[key] === 'string' && raw[key].trim() === '') {
      raw[key] = null;
    }
  }

  const parsed = createDealSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  // Cross-tenant id checks. The FK only ensures the row exists, not that it
  // belongs to *this* tenant — a tampered form could otherwise link to data
  // in someone else's org.
  if (parsed.data.companyId) {
    const [c] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          eq(companies.id, parsed.data.companyId),
          eq(companies.tenantId, tenant.id),
        ),
      )
      .limit(1);
    if (!c) {
      return {
        ok: false,
        message: 'The selected company is not in this tenant.',
        fieldErrors: { companyId: ['Pick a company from the list'] },
      };
    }
  }
  if (parsed.data.contactId) {
    const [c] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, parsed.data.contactId),
          eq(contacts.tenantId, tenant.id),
        ),
      )
      .limit(1);
    if (!c) {
      return {
        ok: false,
        message: 'The selected contact is not in this tenant.',
        fieldErrors: { contactId: ['Pick a contact from the list'] },
      };
    }
  }

  const amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
  const closedAt =
    parsed.data.stage === 'won' || parsed.data.stage === 'lost'
      ? new Date()
      : null;

  const [created] = await db
    .insert(deals)
    .values({
      tenantId: tenant.id,
      companyId: parsed.data.companyId,
      contactId: parsed.data.contactId,
      name: parsed.data.name,
      stage: parsed.data.stage,
      amountMinor,
      currency: parsed.data.currency,
      expectedCloseDate: parsed.data.expectedCloseDate,
      closedAt,
    })
    .returning();

  if (!created) {
    return { ok: false, message: 'Failed to create deal.' };
  }

  revalidatePath('/dashboard/deals');
  return { ok: true, deal: created };
}
