'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { companies, type Company } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  companyIdSchema,
  createCompanySchema,
  updateCompanySchema,
} from '@/lib/companies/schema';

export type CreateCompanyResult =
  | { ok: true; company: Company }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type UpdateCompanyResult = CreateCompanyResult;

export type SimpleResult =
  | { ok: true }
  | { ok: false; message: string };

/* -------- CREATE -------- */

export async function createCompanyAction(
  formData: FormData,
): Promise<CreateCompanyResult> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = createCompanySchema.safeParse({
    name: formData.get('name'),
    domain: formData.get('domain') || null,
    industry: formData.get('industry') || null,
  });
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(companies)
      .values({
        tenantId: tenant.id,
        name: parsed.data.name,
        domain: parsed.data.domain,
        industry: parsed.data.industry,
      })
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'company',
      entityId: row.id,
      action: 'created',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!created) return { ok: false, message: 'Failed to create company.' };

  revalidatePath('/dashboard/companies');
  revalidatePath('/dashboard/activity');
  revalidatePath('/dashboard');
  return { ok: true, company: created };
}

/* -------- UPDATE -------- */

export async function updateCompanyAction(
  formData: FormData,
): Promise<UpdateCompanyResult> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = updateCompanySchema.safeParse({
    id: formData.get('id'),
    name: formData.get('name'),
    domain: formData.get('domain') || null,
    industry: formData.get('industry') || null,
  });
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: 'Please fix the highlighted fields.',
      fieldErrors: flat.fieldErrors as Record<string, string[]>,
    };
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(companies)
      .set({
        name: parsed.data.name,
        domain: parsed.data.domain,
        industry: parsed.data.industry,
      })
      .where(
        and(
          eq(companies.id, parsed.data.id),
          eq(companies.tenantId, tenant.id),
          isNull(companies.deletedAt),
        ),
      )
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'company',
      entityId: row.id,
      action: 'updated',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!updated) {
    return { ok: false, message: 'Company not found in this tenant.' };
  }

  revalidatePath('/dashboard/companies');
  revalidatePath('/dashboard/activity');
  return { ok: true, company: updated };
}

/* -------- SOFT DELETE -------- */

export async function softDeleteCompanyAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = companyIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid company id.' };

  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(companies)
      .set({
        deletedAt: new Date(),
        deletedBy: membership.userId,
      })
      .where(
        and(
          eq(companies.id, idCheck.data.id),
          eq(companies.tenantId, tenant.id),
          isNull(companies.deletedAt),
        ),
      )
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'company',
      entityId: row.id,
      action: 'deleted',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!deleted) {
    return { ok: false, message: 'Company not found or already deleted.' };
  }

  revalidatePath('/dashboard/companies');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- RESTORE -------- */

export async function restoreCompanyAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = companyIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid company id.' };

  const restored = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(companies)
      .set({
        deletedAt: null,
        deletedBy: null,
      })
      .where(
        and(
          eq(companies.id, idCheck.data.id),
          eq(companies.tenantId, tenant.id),
        ),
      )
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'company',
      entityId: row.id,
      action: 'restored',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!restored) {
    return { ok: false, message: 'Company not found in this tenant.' };
  }

  revalidatePath('/dashboard/companies');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}
