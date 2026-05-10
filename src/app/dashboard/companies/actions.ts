'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { companies, type Company } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  companyIdSchema,
  createCompanySchema,
  updateCompanySchema,
} from '@/lib/companies/schema';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { serializeCompany } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

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

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
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

      const created = await tenantTransaction(async (tx) => {
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
        await publishRealtimeEvent(tx, {
          type: 'company.created',
          tenantId: tenant.id,
          company: serializeCompany(row),
        });
        return row;
      });

      if (!created) return { ok: false, message: 'Failed to create company.' };

      // Workflow events ship after commit. The mutation has already
      // succeeded; if the inngest send fails we log and move on (see
      // sendWorkflowEvent's failure-mode for rationale).
      await sendWorkflowEvent('crm/company.created', {
        tenantId: tenant.id,
        companyId: created.id,
        actorUserId: membership.userId,
        name: created.name,
      });
      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'company',
        entityId: created.id,
        actorUserId: membership.userId,
        reason: 'created',
      });

      revalidatePath('/dashboard/companies');
      revalidatePath('/dashboard/activity');
      revalidatePath('/dashboard');
      return { ok: true, company: created };
    },
  );
}

/* -------- UPDATE -------- */

export async function updateCompanyAction(
  formData: FormData,
): Promise<UpdateCompanyResult> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
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

      const updated = await tenantTransaction(async (tx) => {
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
        await publishRealtimeEvent(tx, {
          type: 'company.updated',
          tenantId: tenant.id,
          company: serializeCompany(row),
        });
        return row;
      });

      if (!updated) {
        return { ok: false, message: 'Company not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'company',
        entityId: updated.id,
        actorUserId: membership.userId,
        reason: 'updated',
      });

      revalidatePath('/dashboard/companies');
      revalidatePath('/dashboard/activity');
      return { ok: true, company: updated };
    },
  );
}

/* -------- SOFT DELETE -------- */

export async function softDeleteCompanyAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  // includeDeleted is required: PG 14+ evaluates the SELECT policy's USING
  // expression as a WITH CHECK against the *new* row produced by an
  // UPDATE...RETURNING. Our SELECT policy hides rows with
  // `deleted_at IS NOT NULL` unless `app.include_deleted='true'`. After
  // we set deleted_at on this UPDATE the new row would fail that check
  // and Postgres raises "new row violates row-level security policy".
  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = companyIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid company id.' };

      const deleted = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(companies)
          .set({ deletedAt: new Date(), deletedBy: membership.userId })
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
        await publishRealtimeEvent(tx, {
          type: 'company.deleted',
          tenantId: tenant.id,
          companyId: row.id,
          name: row.name,
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
    },
  );
}

/* -------- HARD DELETE (permanent) -------- */

export async function hardDeleteCompanyAction(
  id: string,
): Promise<SimpleResult> {
  const gate = await checkPermission('hardDeleteCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  // Permanent delete operates on already-soft-deleted rows. We need
  // includeDeleted=true so the SELECT-as-USING that protects DELETE can
  // see the row, mirroring the restore action.
  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = companyIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid company id.' };

      const removed = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .delete(companies)
          .where(
            and(
              eq(companies.id, idCheck.data.id),
              eq(companies.tenantId, tenant.id),
            ),
          )
          .returning();
        return row ?? null;
      });

      if (!removed) {
        return { ok: false, message: 'Company not found in this tenant.' };
      }

      revalidatePath('/dashboard/companies');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- RESTORE -------- */

export async function restoreCompanyAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  // Restore needs to UPDATE a soft-deleted row. The default RLS policy
  // hides deleted_at IS NOT NULL rows from SELECT (which Drizzle's UPDATE
  // ... RETURNING relies on under the hood for the row check). Enter the
  // context with includeDeleted so the UPDATE's USING predicate matches.
  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = companyIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid company id.' };

      const restored = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .update(companies)
          .set({ deletedAt: null, deletedBy: null })
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
        await publishRealtimeEvent(tx, {
          type: 'company.restored',
          tenantId: tenant.id,
          company: serializeCompany(row),
        });
        return row;
      });

      if (!restored) {
        return { ok: false, message: 'Company not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'company',
        entityId: restored.id,
        actorUserId: membership.userId,
        reason: 'restored',
      });

      revalidatePath('/dashboard/companies');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}
