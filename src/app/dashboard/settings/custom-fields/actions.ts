'use server';

import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  customFieldDefinitions,
} from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { slugifyKey } from '@/lib/custom-fields/types';
import { requireMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

export type CfResult = { ok: true } | { ok: false; error: string };

/** Owner/admin gate; returns the tenant id or an error result. */
async function requireAdmin(): Promise<
  { ok: true; tenantId: string } | { ok: false; error: string }
> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }
  return runWithTenantContext({ tenantId, userId }, async () => {
    const m = await requireMembership().catch(() => null);
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      return { ok: false, error: 'Only owners and admins can manage custom fields.' };
    }
    return { ok: true, tenantId };
  });
}

const createSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  label: z.string().trim().min(1, 'Label is required').max(60),
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  required: z.boolean().default(false),
});

export async function createCustomFieldAction(input: unknown): Promise<CfResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid field.' };
  }
  const d = parsed.data;
  const options = d.fieldType === 'select' ? [...new Set(d.options)].filter(Boolean) : [];
  if (d.fieldType === 'select' && options.length === 0) {
    return { ok: false, error: 'Add at least one option for a dropdown field.' };
  }

  const existing = await db
    .select({ key: customFieldDefinitions.key, sortOrder: customFieldDefinitions.sortOrder })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.tenantId, gate.tenantId),
        eq(customFieldDefinitions.entityType, d.entityType),
      ),
    );
  const keys = new Set(existing.map((r) => r.key));
  const base = slugifyKey(d.label) || 'field';
  let key = base;
  let n = 2;
  while (keys.has(key)) key = `${base}_${n++}`;
  const sortOrder = existing.reduce((m, r) => Math.max(m, r.sortOrder), 0) + 1;

  await db.insert(customFieldDefinitions).values({
    tenantId: gate.tenantId,
    entityType: d.entityType,
    key,
    label: d.label,
    fieldType: d.fieldType,
    options,
    required: d.fieldType === 'boolean' ? false : d.required,
    sortOrder,
  });
  revalidatePath('/dashboard/settings/custom-fields');
  return { ok: true };
}

const updateSchema = z.object({
  id: z.uuid(),
  label: z.string().trim().min(1, 'Label is required').max(60),
  options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  required: z.boolean().default(false),
});

/** Edit a field's label / options / required. Key + type stay fixed. */
export async function updateCustomFieldAction(input: unknown): Promise<CfResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid field.' };
  }
  const d = parsed.data;

  const [row] = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.id, d.id),
        eq(customFieldDefinitions.tenantId, gate.tenantId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: 'Field not found.' };

  const options = row.fieldType === 'select' ? [...new Set(d.options)].filter(Boolean) : [];
  if (row.fieldType === 'select' && options.length === 0) {
    return { ok: false, error: 'Add at least one option for a dropdown field.' };
  }

  await db
    .update(customFieldDefinitions)
    .set({
      label: d.label,
      options,
      required: row.fieldType === 'boolean' ? false : d.required,
    })
    .where(
      and(
        eq(customFieldDefinitions.id, d.id),
        eq(customFieldDefinitions.tenantId, gate.tenantId),
      ),
    );
  revalidatePath('/dashboard/settings/custom-fields');
  return { ok: true };
}

export async function setCustomFieldArchivedAction(
  id: string,
  archived: boolean,
): Promise<CfResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  if (!z.uuid().safeParse(id).success) return { ok: false, error: 'Invalid field.' };
  await db
    .update(customFieldDefinitions)
    .set({ archived })
    .where(
      and(
        eq(customFieldDefinitions.id, id),
        eq(customFieldDefinitions.tenantId, gate.tenantId),
      ),
    );
  revalidatePath('/dashboard/settings/custom-fields');
  return { ok: true };
}

/** Move a field up/down by swapping sort_order with its active neighbour. */
export async function moveCustomFieldAction(
  id: string,
  direction: 'up' | 'down',
): Promise<CfResult> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  if (!z.uuid().safeParse(id).success) return { ok: false, error: 'Invalid field.' };

  const [current] = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.id, id),
        eq(customFieldDefinitions.tenantId, gate.tenantId),
      ),
    )
    .limit(1);
  if (!current) return { ok: false, error: 'Field not found.' };

  const siblings = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.tenantId, gate.tenantId),
        eq(customFieldDefinitions.entityType, current.entityType),
        eq(customFieldDefinitions.archived, false),
      ),
    )
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.createdAt));

  const idx = siblings.findIndex((s) => s.id === id);
  const swapWith = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
  if (idx === -1 || !swapWith) return { ok: true }; // already at the edge

  await db
    .update(customFieldDefinitions)
    .set({ sortOrder: swapWith.sortOrder })
    .where(eq(customFieldDefinitions.id, current.id));
  await db
    .update(customFieldDefinitions)
    .set({ sortOrder: current.sortOrder })
    .where(eq(customFieldDefinitions.id, swapWith.id));
  revalidatePath('/dashboard/settings/custom-fields');
  return { ok: true };
}
