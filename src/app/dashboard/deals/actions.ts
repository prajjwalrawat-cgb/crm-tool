'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { companies, contacts, deals, type Deal } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { recordObservation } from '@/lib/agents/observations/record';
import { checkPermission } from '@/lib/auth-guard';
import { sendAutomatedEmailSafe } from '@/lib/email/automation';
import { recordNotificationSafe } from '@/lib/notifications/recorder';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import { KNOWN_CURRENCIES, toMinorUnits } from '@/lib/deals/currency';
import {
  BULK_UPLOAD_HEADERS,
  type BulkUploadHeader,
  normalizeHeader,
  parseCsv,
} from '@/lib/deals/bulk-csv';
import {
  createDealSchema,
  dealIdSchema,
  DEAL_STAGES,
  updateDealSchema,
} from '@/lib/deals/schema';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { loadSerializedDeal } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

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

async function assertContactInTenant(
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.tenantId, tenantId),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

/* -------- CREATE -------- */

export async function createDealAction(
  formData: FormData,
): Promise<CreateDealResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw: Record<string, FormDataEntryValue | null> = {
        name: formData.get('name'),
        description: formData.get('description'),
        stage: formData.get('stage'),
        amount: formData.get('amount'),
        currency: formData.get('currency'),
        expectedCloseDate: formData.get('expectedCloseDate'),
        companyId: formData.get('companyId'),
        contactId: formData.get('contactId'),
        ownerId: formData.get('ownerId'),
      };
      for (const key of [
        'description',
        'expectedCloseDate',
        'companyId',
        'contactId',
        'ownerId',
      ] as const) {
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
      if (
        parsed.data.contactId &&
        !(await assertContactInTenant(tenant.id, parsed.data.contactId))
      ) {
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

      const created = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(deals)
          .values({
            tenantId: tenant.id,
            companyId: parsed.data.companyId,
            contactId: parsed.data.contactId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            stage: parsed.data.stage,
            amountMinor,
            currency: parsed.data.currency,
            expectedCloseDate: parsed.data.expectedCloseDate,
            closedAt,
            ownerId: parsed.data.ownerId ?? null,
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
        const serialized = await loadSerializedDeal(tx, tenant.id, row.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.created',
            tenantId: tenant.id,
            deal: serialized,
          });
        }
        return row;
      });

      if (!created) return { ok: false, message: 'Failed to create deal.' };

      await sendWorkflowEvent('crm/deal.created', {
        tenantId: tenant.id,
        dealId: created.id,
        actorUserId: membership.userId,
        name: created.name,
        stage: created.stage,
      });
      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'deal',
        entityId: created.id,
        actorUserId: membership.userId,
        reason: 'created',
      });

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/activity');
      revalidatePath('/dashboard');
      return { ok: true, deal: created };
    },
  );
}

/* -------- UPDATE -------- */

export async function updateDealAction(
  formData: FormData,
): Promise<UpdateDealResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const raw: Record<string, FormDataEntryValue | null> = {
        id: formData.get('id'),
        name: formData.get('name'),
        description: formData.get('description'),
        stage: formData.get('stage'),
        amount: formData.get('amount'),
        currency: formData.get('currency'),
        expectedCloseDate: formData.get('expectedCloseDate'),
        companyId: formData.get('companyId'),
        contactId: formData.get('contactId'),
      };
      for (const key of [
        'description',
        'expectedCloseDate',
        'companyId',
        'contactId',
      ] as const) {
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
      if (
        parsed.data.contactId &&
        !(await assertContactInTenant(tenant.id, parsed.data.contactId))
      ) {
        return {
          ok: false,
          message: 'The selected contact is not in this tenant.',
          fieldErrors: { contactId: ['Pick a contact from the list'] },
        };
      }

      const amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
      const isClosedStage =
        parsed.data.stage === 'won' || parsed.data.stage === 'lost';

      const result = await tenantTransaction(async (tx) => {
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
        if (!previous) return null;

        let nextClosedAt: Date | null = previous.closedAt;
        if (isClosedStage && !previous.closedAt) nextClosedAt = new Date();
        if (!isClosedStage && previous.closedAt) nextClosedAt = null;

        const [updated] = await tx
          .update(deals)
          .set({
            companyId: parsed.data.companyId,
            contactId: parsed.data.contactId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
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

        const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);

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
          if (serialized) {
            await publishRealtimeEvent(tx, {
              type: 'deal.stage_changed',
              tenantId: tenant.id,
              deal: serialized,
              from: previous.stage,
              to: updated.stage,
            });
          }
        } else {
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: updated.id,
            action: 'updated',
            metadata: { name: updated.name },
          });
          if (serialized) {
            await publishRealtimeEvent(tx, {
              type: 'deal.updated',
              tenantId: tenant.id,
              deal: serialized,
            });
          }
        }

        return updated;
      });

      if (!result) {
        return { ok: false, message: 'Deal not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'deal',
        entityId: result.id,
        actorUserId: membership.userId,
        reason: 'updated',
      });

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath(`/dashboard/deals/${result.id}`);
      revalidatePath('/dashboard/activity');
      return { ok: true, deal: result };
    },
  );
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

export async function updateDealStageAction(
  input: UpdateDealStageInput,
): Promise<UpdateDealStageResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
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

      const result = await tenantTransaction(async (tx) => {
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
        if (!previous) {
          return { row: null, changed: false, previousStage: null };
        }

        if (previous.stage === parsed.data.stage) {
          const [unchanged] = await tx
            .select()
            .from(deals)
            .where(eq(deals.id, previous.id))
            .limit(1);
          return {
            row: unchanged ?? null,
            changed: false,
            previousStage: previous.stage,
          };
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
        if (!updated) {
          return { row: null, changed: false, previousStage: previous.stage };
        }

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

        // Agent learning hook: emit an observation so future
        // followup_timing / velocity / outcome derivations can train
        // on real workflow signal. The observation rolls back with
        // the parent transaction if the stage update is aborted.
        //
        // outcome_score is filled only on terminal stages: +1 for
        // won (reinforces the path that led here), -1 for lost.
        // Intermediate stage transitions have no outcome yet.
        const terminalOutcome =
          parsed.data.stage === 'won'
            ? 1
            : parsed.data.stage === 'lost'
              ? -1
              : undefined;
        await recordObservation(tx, tenant.id, membership.userId, {
          observationType:
            parsed.data.stage === 'won'
              ? 'deal.won'
              : parsed.data.stage === 'lost'
                ? 'deal.lost'
                : 'deal.stage_changed',
          entityType: 'deal',
          entityId: updated.id,
          metadata: {
            name: updated.name,
            from: previous.stage,
            to: updated.stage,
          },
          outcomeScore: terminalOutcome,
        });

        const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.stage_changed',
            tenantId: tenant.id,
            deal: serialized,
            from: previous.stage,
            to: updated.stage,
          });
        }

        return {
          row: updated,
          changed: true,
          previousStage: previous.stage,
        };
      });

      if (!result.row) {
        return { ok: false, message: 'Deal not found in this tenant.' };
      }

      if (result.changed && result.previousStage) {
        // Post-commit notification: terminal-stage owner alert. Best
        // effort — must never roll back the deal update.
        if (
          (result.row.stage === 'won' || result.row.stage === 'lost') &&
          result.row.ownerId &&
          result.row.ownerId !== membership.userId
        ) {
          await recordNotificationSafe({
            tenantId: tenant.id,
            recipientUserId: result.row.ownerId,
            actorUserId: membership.userId,
            type: result.row.stage === 'won' ? 'deal_won' : 'deal_lost',
            title:
              result.row.stage === 'won'
                ? `Deal won: ${result.row.name}`
                : `Deal lost: ${result.row.name}`,
            subtitle: null,
            entityType: 'deal',
            entityId: result.row.id,
            metadata: { from: result.previousStage, to: result.row.stage },
          });
        }

        await sendWorkflowEvent('crm/deal.stage_changed', {
          tenantId: tenant.id,
          dealId: result.row.id,
          actorUserId: membership.userId,
          from: result.previousStage,
          to: result.row.stage,
          name: result.row.name,
        });
        await sendWorkflowEvent('crm/ai.embed_entity', {
          tenantId: tenant.id,
          entityType: 'deal',
          entityId: result.row.id,
          actorUserId: membership.userId,
          reason: 'updated',
        });
      }

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath(`/dashboard/deals/${result.row.id}`);
      if (result.changed) revalidatePath('/dashboard/activity');
      return { ok: true, deal: result.row, changed: result.changed };
    },
  );
}

/* -------- SOFT DELETE -------- */

export async function softDeleteDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('deleteDeals');
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
      const idCheck = dealIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid deal id.' };

      const deleted = await tenantTransaction(async (tx) => {
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
        await publishRealtimeEvent(tx, {
          type: 'deal.deleted',
          tenantId: tenant.id,
          dealId: row.id,
          name: row.name,
        });
        return row;
      });

      if (!deleted) {
        return { ok: false, message: 'Deal not found or already deleted.' };
      }

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- HARD DELETE (permanent) -------- */

export async function hardDeleteDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('hardDeleteDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = dealIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid deal id.' };

      const removed = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .delete(deals)
          .where(and(eq(deals.id, idCheck.data.id), eq(deals.tenantId, tenant.id)))
          .returning();
        return row ?? null;
      });

      if (!removed) {
        return { ok: false, message: 'Deal not found in this tenant.' };
      }

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- RESTORE -------- */

export async function restoreDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('restoreDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    {
      tenantId: tenant.id,
      userId: membership.userId,
      includeDeleted: true,
    },
    async () => {
      const idCheck = dealIdSchema.safeParse({ id });
      if (!idCheck.success) return { ok: false, message: 'Invalid deal id.' };

      const restored = await tenantTransaction(async (tx) => {
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
        const serialized = await loadSerializedDeal(tx, tenant.id, row.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.restored',
            tenantId: tenant.id,
            deal: serialized,
          });
        }
        return row;
      });

      if (!restored) {
        return { ok: false, message: 'Deal not found in this tenant.' };
      }

      await sendWorkflowEvent('crm/ai.embed_entity', {
        tenantId: tenant.id,
        entityType: 'deal',
        entityId: restored.id,
        actorUserId: membership.userId,
        reason: 'restored',
      });

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/recently-deleted');
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- ASSIGN OWNER -------- */

const updateOwnerSchema = z.object({
  id: z.uuid({ message: 'Invalid deal id' }),
  ownerId: z.string().min(1).max(120).nullable(),
});

export type UpdateOwnerInput = { id: string; ownerId: string | null };

export type UpdateOwnerResult =
  | { ok: true; deal: Deal; changed: boolean }
  | { ok: false; message: string };

/**
 * Reassign (or unassign) a deal's owner. Logs an `owner_changed`
 * activity row carrying both the previous and the new owner id so the
 * detail-page timeline can render "Priya reassigned Razorpay to Rahul".
 */
export async function updateDealOwnerAction(
  input: UpdateOwnerInput,
): Promise<UpdateOwnerResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = updateOwnerSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid owner payload' };
      }

      const result = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(deals)
          .where(
            and(
              eq(deals.id, parsed.data.id),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return { changed: false, deal: null as Deal | null };

        if ((previous.ownerId ?? null) === parsed.data.ownerId) {
          return { changed: false, deal: previous };
        }

        const [updated] = await tx
          .update(deals)
          .set({ ownerId: parsed.data.ownerId })
          .where(eq(deals.id, parsed.data.id))
          .returning();
        if (!updated) return { changed: false, deal: null as Deal | null };

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
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
          deal: updated,
          newOwnerId: updated.ownerId,
          previousOwnerId: previous.ownerId ?? null,
        };
      });

      if (!result.deal) {
        return { ok: false, message: 'Deal not found' };
      }

      // Post-commit, best-effort notification. A failure here MUST NOT
      // roll back the ownership change. See recordNotificationSafe.
      if (
        result.changed &&
        'newOwnerId' in result &&
        result.newOwnerId &&
        result.newOwnerId !== membership.userId
      ) {
        // In-app notification (bell).
        await recordNotificationSafe({
          tenantId: tenant.id,
          recipientUserId: result.newOwnerId,
          actorUserId: membership.userId,
          type: 'owner_changed',
          title: `You now own ${result.deal.name}`,
          subtitle: null,
          entityType: 'deal',
          entityId: result.deal.id,
          metadata: { from: result.previousOwnerId },
        });

        // Real email to the new owner. Operational, not customer-facing —
        // skipped in console-provider dev mode. Best-effort; failures are
        // logged but never crash the reassignment.
        await sendAutomatedEmailSafe({
          tenantId: tenant.id,
          recipientUserId: result.newOwnerId,
          actorUserId: membership.userId,
          subject: `You've been assigned: ${result.deal.name}`,
          textBody:
            `Hi,\n\n` +
            `${result.deal.name} has been assigned to you in the CRM.\n\n` +
            `Open it: /dashboard/deals/${result.deal.id}\n\n` +
            `— Automated from the CRM`,
          entityType: 'deal',
          entityId: result.deal.id,
          metadata: {
            kind: 'owner_changed',
            dealName: result.deal.name,
            previousOwnerId: result.previousOwnerId,
          },
        });
      }

      revalidatePath('/dashboard/deals');
      revalidatePath(`/dashboard/deals/${result.deal.id}`);
      return { ok: true, deal: result.deal, changed: result.changed };
    },
  );
}

/* -------- BULK UPLOAD (CSV) -------- */

export type BulkUploadResult = {
  ok: true;
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
};

export type BulkUploadFailure = {
  ok: false;
  message: string;
};

const MAX_BULK_ROWS = 1000;
const MAX_BULK_FILE_BYTES = 2 * 1024 * 1024; // 2 MB — CSVs are tiny

/**
 * Parse a CSV upload and create deals in one transaction. Per-row
 * errors are collected and returned alongside the success count so
 * the UI can show a partial-success summary; the whole batch only
 * fails on auth, file-size, or empty/no-header conditions.
 *
 * Header aliases tolerated (see normalizeHeader). Company column
 * resolves by exact name match — unknown company is a row error,
 * not an auto-create (auto-create would let typos bloat the
 * companies table).
 */
export async function bulkUploadDealsAction(
  formData: FormData,
): Promise<BulkUploadResult | BulkUploadFailure> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, message: 'No file uploaded.' };
  }
  if (file.size === 0) {
    return { ok: false, message: 'The uploaded file is empty.' };
  }
  if (file.size > MAX_BULK_FILE_BYTES) {
    return {
      ok: false,
      message: `File is too large (max ${Math.round(MAX_BULK_FILE_BYTES / 1024)} KB).`,
    };
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { ok: false, message: 'CSV is empty.' };
  }
  if (rows.length > MAX_BULK_ROWS + 1) {
    return {
      ok: false,
      message: `Too many rows (max ${MAX_BULK_ROWS}). Split the file and retry.`,
    };
  }

  const headerRow = rows[0];
  const headerMap = new Map<BulkUploadHeader, number>();
  headerRow.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    if (h && !headerMap.has(h)) headerMap.set(h, idx);
  });

  if (!headerMap.has('name')) {
    return {
      ok: false,
      message: `Missing required column "name". Expected headers: ${BULK_UPLOAD_HEADERS.join(', ')}.`,
    };
  }

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // Pre-fetch all tenant companies so we can resolve company
      // names without a DB round-trip per row.
      const companyRows = await tenantTransaction(async (tx) =>
        tx
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(
            and(eq(companies.tenantId, tenant.id), isNull(companies.deletedAt)),
          ),
      );
      const companyByName = new Map<string, string>(
        companyRows.map((c) => [c.name.trim().toLowerCase(), c.id]),
      );

      const errors: Array<{ row: number; message: string }> = [];
      const toInsert: typeof deals.$inferInsert[] = [];

      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i];
        // CSV rows can come with fewer cells than the header when
        // trailing fields are blank — read defensively.
        const cell = (h: BulkUploadHeader): string => {
          const idx = headerMap.get(h);
          if (idx === undefined) return '';
          return (cells[idx] ?? '').trim();
        };

        const name = cell('name');
        if (!name) {
          // Skip wholly empty rows silently; flag rows that have
          // *something* but no name.
          if (cells.some((c) => c && c.trim().length > 0)) {
            errors.push({ row: i + 1, message: 'Missing required field "name".' });
          }
          continue;
        }

        const stageRaw = cell('stage').toLowerCase();
        const stage = (stageRaw || 'lead') as (typeof DEAL_STAGES)[number];
        if (!DEAL_STAGES.includes(stage)) {
          errors.push({
            row: i + 1,
            message: `Invalid stage "${stageRaw}". Use one of: ${DEAL_STAGES.join(', ')}.`,
          });
          continue;
        }

        const amountRaw = cell('amount');
        const amount = amountRaw ? Number(amountRaw) : 0;
        if (!Number.isFinite(amount) || amount < 0) {
          errors.push({ row: i + 1, message: `Invalid amount "${amountRaw}".` });
          continue;
        }

        const currencyRaw = cell('currency').toUpperCase();
        const currency = (currencyRaw || 'USD') as (typeof KNOWN_CURRENCIES)[number];
        if (!KNOWN_CURRENCIES.includes(currency)) {
          errors.push({
            row: i + 1,
            message: `Unsupported currency "${currencyRaw}".`,
          });
          continue;
        }

        const closeRaw = cell('expectedCloseDate');
        let expectedCloseDate: string | null = null;
        if (closeRaw) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(closeRaw)) {
            errors.push({
              row: i + 1,
              message: `Invalid expectedCloseDate "${closeRaw}". Use YYYY-MM-DD.`,
            });
            continue;
          }
          expectedCloseDate = closeRaw;
        }

        let companyId: string | null = null;
        const companyNameRaw = cell('companyName');
        if (companyNameRaw) {
          const id = companyByName.get(companyNameRaw.toLowerCase());
          if (!id) {
            errors.push({
              row: i + 1,
              message: `Unknown company "${companyNameRaw}". Create it first or correct the name.`,
            });
            continue;
          }
          companyId = id;
        }

        const description = cell('description') || null;
        const isClosedStage = stage === 'won' || stage === 'lost';

        toInsert.push({
          tenantId: tenant.id,
          companyId,
          contactId: null,
          name,
          description,
          stage,
          amountMinor: toMinorUnits(amount, currency),
          currency,
          expectedCloseDate,
          closedAt: isClosedStage ? new Date() : null,
          ownerId: membership.userId,
        });
      }

      let inserted = 0;
      if (toInsert.length > 0) {
        const result = await tenantTransaction(async (tx) => {
          // Single multi-row INSERT — fast, atomic, and we don't
          // bother emitting realtime events per row to avoid a
          // notification storm. The list/board pages revalidate
          // below and rehydrate from the DB instead.
          const inserted = await tx
            .insert(deals)
            .values(toInsert)
            .returning({ id: deals.id, name: deals.name });
          for (const row of inserted) {
            await recordActivity(tx, {
              tenantId: tenant.id,
              actorUserId: membership.userId,
              entityType: 'deal',
              entityId: row.id,
              action: 'created',
              metadata: { name: row.name, viaBulkUpload: true },
            });
          }
          return inserted.length;
        });
        inserted = result;
      }

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/activity');
      revalidatePath('/dashboard');

      return {
        ok: true,
        inserted,
        skipped: errors.length,
        errors,
      };
    },
  );
}
