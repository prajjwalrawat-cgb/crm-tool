'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { companies, type Company } from '@/db/schema';
import { createCompanySchema } from '@/lib/companies/schema';
import { requireTenant } from '@/lib/tenant';

export type CreateCompanyResult =
  | { ok: true; company: Company }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export async function createCompanyAction(
  formData: FormData,
): Promise<CreateCompanyResult> {
  const tenant = await requireTenant();

  const raw = {
    name: formData.get('name'),
    domain: formData.get('domain') || null,
    industry: formData.get('industry') || null,
  };

  const parsed = createCompanySchema.safeParse(raw);

  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const [created] = await db
    .insert(companies)
    .values({
      tenantId: tenant.id,
      name: parsed.data.name,
      domain: parsed.data.domain,
      industry: parsed.data.industry,
    })
    .returning();

  if (!created) {
    return { ok: false, message: 'Failed to create company.' };
  }

  revalidatePath('/dashboard/companies');
  return { ok: true, company: created };
}
