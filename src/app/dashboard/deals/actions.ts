'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db';
import { companies, contacts, deals, type Deal } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { checkPermission } from '@/lib/auth-guard';
import { toMinorUnits } from '@/lib/deals/currency';
import {
  createDealSchema,
  dealIdSchema,
  DEAL_STAGES,
  updateDealSchema,
} from '@/lib/deals/schema';

export type CreateDealResult =
  | { ok: true; deal: Deal }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type UpdateDealResult = CreateDealResult;

export type SimpleResult =
  | { ok: true }
  | { ok: false; message: string };

async function assertCompanyInTenant(
  tenantId: string,
  companyId: string,
): Promise<boolean> {
  const [c] = await db
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
  return Boolean(c);
}

async function assertContactInTenant(
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const [c] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, contactId),
        eq(contacts.tenantId, tenantId),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(c);
}

/* -------- CREATE -------- */

export async function createDealAction(
  formData: FormData,
): Promise<CreateDealResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

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
    if (typeof raw[key] === 'string' && raw[key].trim() === '') raw[key] = null;
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

  if (parsed.data.companyId && !(await assertCompanyInTenant(tenant.id, parsed.data.companyId))) {
    return {
      ok: false,
      message: 'The selected company is not in this tenant.',
      fieldErrors: { companyId: ['Pick a company from the list'] },
    };
  }
  if (parsed.data.contactId && !(await assertContactInTenant(tenant.id, parsed.data.contactId))) {
    return {
      ok: false,
      message: 'The selected contact is not in this tenant.',
      fieldErrors: { contactId: ['Pick a contact from the list'] },
    };
  }

  const amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
  const closedAt =
    parsed.data.stage === 'won' || parsed.data.stage === 'lost'
      ? new Date()
      : null;

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
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
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'deal',
      entityId: row.id,
      action: 'created',
      metadata: { name: row.name, stage: row.stage },
    });
    return row;
  });

  if (!created) return { ok: false, message: 'Failed to create deal.' };

  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/activity');
  revalidatePath('/dashboard');
  return { ok: true, deal: created };
}

/* -------- UPDATE -------- */

export async function updateDealAction(
  formData: FormData,
): Promise<UpdateDealResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const raw: Record<string, FormDataEntryValue | null> = {
    id: formData.get('id'),
    name: formData.get('name'),
    stage: formData.get('stage'),
    amount: formData.get('amount'),
    currency: formData.get('currency'),
    expectedCloseDate: formData.get('expectedCloseDate'),
    companyId: formData.get('companyId'),
    contactId: formData.get('contactId'),
  };
  for (const key of ['expectedCloseDate', 'companyId', 'contactId'] as const) {
    if (typeof raw[key] === 'string' && raw[key].trim() === '') raw[key] = null;
  }

  const parsed = updateDealSchema.safeParse(raw);
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
  if (parsed.data.contactId && !(await assertContactInTenant(tenant.id, parsed.data.contactId))) {
    return {
      ok: false,
      message: 'The selected contact is not in this tenant.',
      fieldErrors: { contactId: ['Pick a contact from the list'] },
    };
  }

  const amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
  const isClosedStage =
    parsed.data.stage === 'won' || parsed.data.stage === 'lost';

  const result = await db.transaction(async (tx) => {
    // Read current row to detect stage transitions for the activity log.
    const [previous] = await tx
      .select({ id: deals.id, stage: deals.stage, name: deals.name, closedAt: deals.closedAt })
      .from(deals)
      .where(
        and(
          eq(deals.id, parsed.data.id),
          eq(deals.tenantId, tenant.id),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1);
    if (!previous) return null;

    // Set closedAt on transition into a closed stage; clear it on transition
    // out of one. Without the clear-on-exit branch, moving a deal back from
    // won/lost to negotiation would leave a stale closedAt.
    let nextClosedAt: Date | null = previous.closedAt;
    if (isClosedStage && !previous.closedAt) nextClosedAt = new Date();
    if (!isClosedStage && previous.closedAt) nextClosedAt = null;

    const [updated] = await tx
      .update(deals)
      .set({
        companyId: parsed.data.companyId,
        contactId: parsed.data.contactId,
        name: parsed.data.name,
        stage: parsed.data.stage,
        amountMinor,
        currency: parsed.data.currency,
        expectedCloseDate: parsed.data.expectedCloseDate,
        closedAt: nextClosedAt,
      })
      .where(
        and(
          eq(deals.id, parsed.data.id),
          eq(deals.tenantId, tenant.id),
          isNull(deals.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;

    if (previous.stage !== updated.stage) {
      await recordActivity(tx, {
        tenantId: tenant.id,
        actorUserId: membership.userId,
        entityType: 'deal',
        entityId: updated.id,
        action: 'stage_changed',
        metadata: {
          name: updated.name,
          from: previous.stage,
          to: updated.stage,
        },
      });
    } else {
      await recordActivity(tx, {
        tenantId: tenant.id,
        actorUserId: membership.userId,
        entityType: 'deal',
        entityId: updated.id,
        action: 'updated',
        metadata: { name: updated.name },
      });
    }

    return updated;
  });

  if (!result) {
    return { ok: false, message: 'Deal not found in this tenant.' };
  }

  revalidatePath('/dashboard/deals');
  revalidatePath(`/dashboard/deals/${result.id}`);
  revalidatePath('/dashboard/activity');
  return { ok: true, deal: result };
}

/* -------- UPDATE STAGE (kanban) -------- */

const updateStageSchema = z.object({
  id: z.uuid({ message: 'Invalid deal id' }),
  stage: z.enum(DEAL_STAGES, { message: 'Invalid stage' }),
});

export type UpdateDealStageInput = {
  id: string;
  stage: string;
};

export type UpdateDealStageResult =
  | { ok: true; deal: Deal; changed: boolean }
  | { ok: false; message: string };

/**
 * Move a single deal to a new stage. Used by the kanban DnD on every drop.
 *
 * Idempotent: if the deal is already in the requested stage, this is a no-op
 * (no DB write, no activity log, returns `changed: false`). Drag-and-drop
 * tooling sometimes fires `onDragEnd` for in-place drops; we don't want to
 * spam the audit log with redundant entries.
 *
 * Closed-state invariant: transitioning into won/lost sets `closedAt` if it
 * isn't already set; transitioning *out* clears it. Mirrors the same logic
 * in `updateDealAction` so the two paths can never disagree.
 *
 * Race: this is "last writer wins" — two concurrent drags by different
 * users will both succeed and the activity log records both transitions.
 * Stale-overwrite protection is intentionally not added here (see phase
 * deliverables for the rationale).
 */
export async function updateDealStageAction(
  input: UpdateDealStageInput,
): Promise<UpdateDealStageResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = updateStageSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    return {
      ok: false,
      message: flat.formErrors[0] ?? 'Invalid stage transition.',
    };
  }

  const isClosed =
    parsed.data.stage === 'won' || parsed.data.stage === 'lost';

  const result = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({
        id: deals.id,
        stage: deals.stage,
        name: deals.name,
        closedAt: deals.closedAt,
      })
      .from(deals)
      .where(
        and(
          eq(deals.id, parsed.data.id),
          eq(deals.tenantId, tenant.id),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1);
    if (!previous) return { row: null, changed: false };

    if (previous.stage === parsed.data.stage) {
      // Re-fetch full row so the caller's optimistic state can settle on
      // server data without a wasteful update.
      const [unchanged] = await tx
        .select()
        .from(deals)
        .where(eq(deals.id, previous.id))
        .limit(1);
      return { row: unchanged ?? null, changed: false };
    }

    let nextClosedAt: Date | null = previous.closedAt;
    if (isClosed && !previous.closedAt) nextClosedAt = new Date();
    if (!isClosed && previous.closedAt) nextClosedAt = null;

    const [updated] = await tx
      .update(deals)
      .set({
        stage: parsed.data.stage,
        closedAt: nextClosedAt,
      })
      .where(
        and(
          eq(deals.id, parsed.data.id),
          eq(deals.tenantId, tenant.id),
          isNull(deals.deletedAt),
        ),
      )
      .returning();
    if (!updated) return { row: null, changed: false };

    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'deal',
      entityId: updated.id,
      action: 'stage_changed',
      metadata: {
        name: updated.name,
        from: previous.stage,
        to: updated.stage,
      },
    });

    return { row: updated, changed: true };
  });

  if (!result.row) {
    return { ok: false, message: 'Deal not found in this tenant.' };
  }

  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/deals/board');
  revalidatePath(`/dashboard/deals/${result.row.id}`);
  if (result.changed) revalidatePath('/dashboard/activity');
  return { ok: true, deal: result.row, changed: result.changed };
}

/* -------- SOFT DELETE -------- */

export async function softDeleteDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = dealIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid deal id.' };

  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(deals)
      .set({ deletedAt: new Date(), deletedBy: membership.userId })
      .where(
        and(
          eq(deals.id, idCheck.data.id),
          eq(deals.tenantId, tenant.id),
          isNull(deals.deletedAt),
        ),
      )
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'deal',
      entityId: row.id,
      action: 'deleted',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!deleted) {
    return { ok: false, message: 'Deal not found or already deleted.' };
  }

  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}

/* -------- RESTORE -------- */

export async function restoreDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const idCheck = dealIdSchema.safeParse({ id });
  if (!idCheck.success) return { ok: false, message: 'Invalid deal id.' };

  const restored = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(deals)
      .set({ deletedAt: null, deletedBy: null })
      .where(
        and(
          eq(deals.id, idCheck.data.id),
          eq(deals.tenantId, tenant.id),
        ),
      )
      .returning();
    if (!row) return null;
    await recordActivity(tx, {
      tenantId: tenant.id,
      actorUserId: membership.userId,
      entityType: 'deal',
      entityId: row.id,
      action: 'restored',
      metadata: { name: row.name },
    });
    return row;
  });

  if (!restored) {
    return { ok: false, message: 'Deal not found in this tenant.' };
  }

  revalidatePath('/dashboard/deals');
  revalidatePath('/dashboard/recently-deleted');
  revalidatePath('/dashboard/activity');
  return { ok: true };
}
