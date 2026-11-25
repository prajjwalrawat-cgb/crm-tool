'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { companies, type Company } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import {
  customFieldFieldErrors,
  parseCustomFieldsForm,
} from '@/lib/custom-fields/form';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import { recordNotificationSafe } from '@/lib/notifications/recorder';
import {
  companyIdSchema,
  createCompanySchema,
  patchCompanySchema,
  updateCompanySchema,
} from '@/lib/companies/schema';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { getMapsProvider } from '@/lib/field/maps';
import { geocodeStore } from '@/lib/field/maps/cached';
import { pinCompanySite, propagateCompanyPoint } from '@/lib/field/meetings';
import { companyGeocodeLine, fetchPre, lookupPre } from '@/lib/field/site';
import { FieldError } from '@/lib/field/types';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { can } from '@/lib/rbac';
import { serializeCompany } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { normalizeCompanyName } from '@/lib/dedup/normalize';
import { findCompanyMatches, type DedupMatch } from '@/lib/dedup/queries';
import { isFeatureEnabled } from '@/lib/workspace-settings/queries';

/**
 * Live "similar existing company" lookup for the create form (Module 5).
 * Read-only; returns [] when DEDUP_ENABLED is off. Debounced client-side.
 */
export async function findSimilarCompaniesAction(
  name: string,
): Promise<DedupMatch[]> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return [];
  const { tenant, membership } = gate;
  if (!name || name.trim().length < 2) return [];
  return runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      if (!(await isFeatureEnabled(tenant.id, 'dedupEnabled'))) return [];
      return findCompanyMatches(tenant.id, name);
    },
  );
}

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
        ownerId: formData.get('ownerId') || null,
      });
      if (!parsed.success) {
        const flat = z.flattenError(parsed.error);
        return {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: flat.fieldErrors as Record<string, string[]>,
        };
      }

      const defs = await listCustomFieldDefs(tenant.id, 'company');
      const cf = parseCustomFieldsForm(defs, formData);
      if (!cf.ok) {
        return {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: customFieldFieldErrors(cf.errors),
        };
      }

      // "Create anyway" flag — the create form sets this when the user proceeds
      // past a surfaced duplicate warning (Module 5).
      const dedupOverride = formData.get('dedupOverride') === '1';

      const created = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(companies)
          .values({
            tenantId: tenant.id,
            name: parsed.data.name,
            domain: parsed.data.domain,
            industry: parsed.data.industry,
            ownerId: parsed.data.ownerId ?? null,
            updatedBy: membership.userId,
            customFields: cf.values,
            normalizedName: normalizeCompanyName(parsed.data.name),
            dedupOverride,
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
        if (dedupOverride) {
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'company',
            entityId: row.id,
            action: 'dedup_override',
            metadata: { name: row.name },
          });
        }
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

const ADDRESS_FIELDS = ['address', 'city', 'state', 'postalCode'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

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

      const defs = await listCustomFieldDefs(tenant.id, 'company');
      const cf = parseCustomFieldsForm(defs, formData);
      if (!cf.ok) {
        return {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: customFieldFieldErrors(cf.errors),
        };
      }

      // Field Meetings: address block (anyone who can edit) and site pin /
      // radius (pinFieldSites only). The form only sends these when it shows them.
      const textOrNull = (key: string, max: number): string | null | undefined => {
        if (!formData.has(key)) return undefined;
        const v = String(formData.get(key) ?? '').trim();
        return v ? v.slice(0, max) : null;
      };
      const addressIn: Partial<Record<AddressField, string | null>> = {};
      for (const f of ADDRESS_FIELDS) {
        const v = textOrNull(f, f === 'address' ? 500 : 120);
        if (v !== undefined) addressIn[f] = v;
      }
      const canPin = can(membership.role, 'pinFieldSites');
      const pinText = canPin ? String(formData.get('sitePin') ?? '').trim() : '';
      let radius: number | null | undefined;
      if (canPin && formData.has('checkinRadiusM')) {
        const raw = String(formData.get('checkinRadiusM') ?? '').trim();
        radius = raw === '' ? null : Number(raw);
        if (radius !== null && (!Number.isInteger(radius) || radius < 50 || radius > 5000)) {
          return {
            ok: false,
            message: 'Please fix the highlighted fields.',
            fieldErrors: { checkinRadiusM: ['Whole number from 50 to 5000 metres, or blank for the workspace default.'] },
          };
        }
      }

      // 1. Pin first (network for short links happens inside, outside our write transaction).
      //    A manual pin makes the address edit below keep its coordinates.
      if (pinText) {
        try {
          await pinCompanySite(
            { tenantId: tenant.id, userId: membership.userId, role: membership.role },
            parsed.data.id,
            pinText,
            radius,
          );
        } catch (e) {
          if (e instanceof FieldError) {
            return {
              ok: false,
              message: 'Please fix the highlighted fields.',
              fieldErrors: { sitePin: [e.message] },
            };
          }
          throw e;
        }
      }

      // 2. Plan the geocode (read tx -> network -> write tx), never a network call under the write.
      const maps = getMapsProvider();
      const plan = await tenantTransaction(async (tx) => {
        const [cur] = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, parsed.data.id), eq(companies.tenantId, tenant.id), isNull(companies.deletedAt)))
          .limit(1);
        if (!cur) return null;
        const next = {
          address: addressIn.address !== undefined ? addressIn.address : cur.address,
          city: addressIn.city !== undefined ? addressIn.city : cur.city,
          state: addressIn.state !== undefined ? addressIn.state : cur.state,
          postalCode: addressIn.postalCode !== undefined ? addressIn.postalCode : cur.postalCode,
        };
        const changed = ADDRESS_FIELDS.some((f) => addressIn[f] !== undefined && addressIn[f] !== cur[f]);
        // Re-locate on an address change, and retry companies that still have no point
        // (e.g. saved before a MAPS_API_KEY existed). Manual pins are never overwritten.
        const regeocode = cur.geocodeStatus !== 'manual' && (changed || (cur.lat === null && companyGeocodeLine(next) !== null));
        const target = regeocode ? companyGeocodeLine(next) : null;
        // Addresses that company meetings may carry when they inherited it (old line, old street).
        const prevAddresses = [companyGeocodeLine(cur), cur.address];
        return { next, regeocode, target, prevAddresses, cached: await lookupPre(tx, tenant.id, target) };
      });
      if (!plan) return { ok: false, message: 'Company not found in this tenant.' };
      const pre = await fetchPre(plan.target, plan.cached, maps);

      const updated = await tenantTransaction(async (tx) => {
        const site: Partial<typeof companies.$inferInsert> = { ...plan.next };
        if (plan.regeocode) {
          if (!plan.target) {
            // Address cleared: nothing to locate.
            Object.assign(site, { lat: null, lng: null, geocodeStatus: null });
          } else if (pre && pre.result.status === 'ok' && pre.result.point) {
            if (pre.store) await geocodeStore(tx, tenant.id, pre.address, pre.result, maps.name);
            Object.assign(site, { lat: pre.result.point.lat, lng: pre.result.point.lng, geocodeStatus: 'ok' });
          } else {
            const failed = pre?.result.status === 'failed';
            if (pre?.store && failed) await geocodeStore(tx, tenant.id, pre.address, pre.result, maps.name);
            Object.assign(site, { lat: null, lng: null, geocodeStatus: failed ? 'failed' : 'pending' });
          }
        }
        if (radius !== undefined && !pinText) site.checkinRadiusM = radius;
        const [row] = await tx
          .update(companies)
          .set({
            name: parsed.data.name,
            domain: parsed.data.domain,
            industry: parsed.data.industry,
            updatedBy: membership.userId,
            customFields: cf.values,
            ...site,
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
        // A fresh (non-manual) point reaches the company's not-started meetings that have no site yet.
        if (plan.regeocode && row.lat !== null && row.lng !== null && row.geocodeStatus === 'ok') {
          await propagateCompanyPoint(
            tx,
            tenant.id,
            { ...row, lat: row.lat, lng: row.lng },
            [...plan.prevAddresses, companyGeocodeLine(row), row.address],
            new Date(),
          );
        }
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

/* -------- INLINE PATCH (click-to-edit cells) -------- */

export type PatchCompanyResult =
  | { ok: true }
  | { ok: false; message: string };

/** Partial field update for inline company-table editing. */
export async function patchCompanyAction(
  input: unknown,
): Promise<PatchCompanyResult> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = patchCompanySchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message:
        flat.formErrors[0] ??
        Object.values(flat.fieldErrors).flat()[0] ??
        'Invalid update.',
    };
  }
  const d = parsed.data;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const updated = await tenantTransaction(async (tx) => {
        const patch: Record<string, unknown> = {};
        if (d.name !== undefined) patch.name = d.name;
        if (d.domain !== undefined)
          patch.domain = d.domain?.trim() ? d.domain.trim() : null;
        if (d.industry !== undefined)
          patch.industry = d.industry?.trim() ? d.industry.trim() : null;
        if (d.ownerId !== undefined) patch.ownerId = d.ownerId;
        if (Object.keys(patch).length === 0) return null;
        patch.updatedBy = membership.userId;

        const [row] = await tx
          .update(companies)
          .set(patch)
          .where(
            and(
              eq(companies.id, d.id),
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

      if (!updated) return { ok: false, message: 'Company not found.' };
      revalidatePath('/dashboard/companies');
      // The Account 360 view renders these fields too, so an inline edit
      // there has to invalidate the detail route as well as the list.
      revalidatePath('/dashboard/companies/[id]', 'page');
      revalidatePath('/dashboard/activity');
      return { ok: true };
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

/* -------- ASSIGN OWNER -------- */

const updateCompanyOwnerSchema = z.object({
  id: z.uuid({ message: 'Invalid company id' }),
  ownerId: z.string().min(1).max(120).nullable(),
});

export type UpdateCompanyOwnerInput = {
  id: string;
  ownerId: string | null;
};

export type UpdateCompanyOwnerResult =
  | { ok: true; company: Company; changed: boolean }
  | { ok: false; message: string };

/**
 * Reassign (or unassign) a company's owner. Mirrors the deal owner
 * action: activity log + notification to the new owner. The recorder
 * skips self-targets, so picking yourself is silent.
 */
export async function updateCompanyOwnerAction(
  input: UpdateCompanyOwnerInput,
): Promise<UpdateCompanyOwnerResult> {
  const gate = await checkPermission('manageCompanies');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = updateCompanyOwnerSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid owner payload' };
      }

      const result = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(companies)
          .where(
            and(
              eq(companies.id, parsed.data.id),
              eq(companies.tenantId, tenant.id),
              isNull(companies.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return { changed: false, company: null as Company | null };

        if ((previous.ownerId ?? null) === parsed.data.ownerId) {
          return { changed: false, company: previous };
        }

        const [updated] = await tx
          .update(companies)
          .set({ ownerId: parsed.data.ownerId, updatedBy: membership.userId })
          .where(eq(companies.id, parsed.data.id))
          .returning();
        if (!updated) return { changed: false, company: null as Company | null };

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'company',
          entityId: updated.id,
          action: 'owner_changed',
          metadata: {
            name: updated.name,
            from: previous.ownerId ?? null,
            to: updated.ownerId ?? null,
          },
        });

        return {
          changed: true,
          company: updated,
          newOwnerId: updated.ownerId,
          previousOwnerId: previous.ownerId ?? null,
        };
      });

      if (!result.company) {
        return { ok: false, message: 'Company not found' };
      }

      // Post-commit, best-effort notification. Never crashes the action.
      if (
        result.changed &&
        'newOwnerId' in result &&
        result.newOwnerId &&
        result.newOwnerId !== membership.userId
      ) {
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: result.newOwnerId,
          actorUserId: membership.userId,
          type: 'owner_changed',
          title: `You now own ${result.company.name}`,
          subtitle: 'Company',
          entityType: 'company',
          entityId: result.company.id,
          metadata: { from: result.previousOwnerId },
        });
      }

      revalidatePath('/dashboard/companies');
      revalidatePath(`/dashboard/companies/${result.company.id}`);
      return { ok: true, company: result.company, changed: result.changed };
    },
  );
}
