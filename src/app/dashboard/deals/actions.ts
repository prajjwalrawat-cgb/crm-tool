'use server';

import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { companies, contacts, deals, memberships, type Deal } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { recordObservation } from '@/lib/agents/observations/record';
import { checkPermission } from '@/lib/auth-guard';
import { listCustomFieldDefs } from '@/lib/custom-fields/queries';
import {
  type CustomFieldDef,
  validateCustomFields,
} from '@/lib/custom-fields/types';
import { sendAutomatedEmailSafe } from '@/lib/email/automation';
import { recordNotificationSafe } from '@/lib/notifications/recorder';
import {
  runWithTenantContext,
  tenantTransaction,
} from '@/lib/db-context';
import {
  approvalForTransition,
  approvalOnEnterWon,
  marginPctToBps,
} from '@/lib/deals/approval';
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
  patchDealSchema,
  updateDealSchema,
} from '@/lib/deals/schema';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { personaOf } from '@/lib/personas';
import { canApproveDeals } from '@/lib/rbac';
import { loadSerializedDeal } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

export type CreateDealResult =
  | { ok: true; deal: Deal }
  | { ok: false; message: string; fieldErrors?: Record<string, string[]> };

export type UpdateDealResult = CreateDealResult;

export type SimpleResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Read custom-field values out of FormData (inputs are named `cf_<key>`) and
 * validate them against the active definitions. Returns normalized values or
 * per-field errors (keyed by `cf_<key>` for the forms).
 */
function parseCustomFields(formData: FormData, defs: CustomFieldDef[]) {
  const raw: Record<string, unknown> = {};
  for (const def of defs) {
    const name = `cf_${def.key}`;
    if (def.fieldType === 'boolean') {
      raw[def.key] = formData.get(name) != null;
    } else {
      const v = formData.get(name);
      raw[def.key] = typeof v === 'string' ? v : '';
    }
  }
  return validateCustomFields(defs, raw);
}

function customFieldErrors(errors: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(errors).map(([k, m]) => [`cf_${k}`, [m]]),
  );
}

/**
 * Validate the chosen Company/Contact links: they must exist in the tenant,
 * the contact must belong to the chosen company, and (for sales members) both
 * must be owned-or-unassigned. Returns the normalized ids or an error.
 */
async function resolveDealLinks(
  tenantId: string,
  restrictToOwnerId: string | undefined,
  companyId: string | null,
  contactId: string | null,
): Promise<
  | { ok: true; companyId: string | null; contactId: string | null }
  | { ok: false; message: string; field: 'companyId' | 'contactId' }
> {
  const cId = companyId;
  let ctId = contactId;

  if (cId) {
    const [c] = await tenantTransaction((tx) =>
      tx
        .select({ ownerId: companies.ownerId })
        .from(companies)
        .where(
          and(
            eq(companies.id, cId),
            eq(companies.tenantId, tenantId),
            isNull(companies.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!c) return { ok: false, message: 'Selected company not found.', field: 'companyId' };
    if (restrictToOwnerId && c.ownerId && c.ownerId !== restrictToOwnerId) {
      return { ok: false, message: "You can't link that company.", field: 'companyId' };
    }
  } else {
    ctId = null; // No company → no contact.
  }

  if (ctId) {
    const [ct] = await tenantTransaction((tx) =>
      tx
        .select({ ownerId: contacts.ownerId, companyId: contacts.companyId })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, ctId),
            eq(contacts.tenantId, tenantId),
            isNull(contacts.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!ct) return { ok: false, message: 'Selected contact not found.', field: 'contactId' };
    if (restrictToOwnerId && ct.ownerId && ct.ownerId !== restrictToOwnerId) {
      return { ok: false, message: "You can't link that contact.", field: 'contactId' };
    }
    if (cId && ct.companyId && ct.companyId !== cId) {
      return {
        ok: false,
        message: 'Contact does not belong to the selected company.',
        field: 'contactId',
      };
    }
  }

  return { ok: true, companyId: cId, contactId: ctId };
}

/** A member's role in the tenant (for assign-permission checks). */
async function getMemberRole(
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      )
      .limit(1),
  );
  return rows[0]?.role ?? null;
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
      // Company/Contact are linked records chosen from role-scoped dropdowns.
      const raw: Record<string, FormDataEntryValue | null> = {
        name: formData.get('name'),
        description: formData.get('description'),
        stage: formData.get('stage'),
        amount: formData.get('amount'),
        currency: formData.get('currency'),
        expectedCloseDate: formData.get('expectedCloseDate'),
        companyId: formData.get('companyId') || null,
        contactId: formData.get('contactId') || null,
        unitPrice: formData.get('unitPrice'),
        quantity: formData.get('quantity'),
        marginPct: formData.get('marginPct'),
        ownerId: formData.get('ownerId'),
      };
      for (const key of ['description', 'expectedCloseDate', 'ownerId'] as const) {
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

      // Validate the Company/Contact links against tenant + role scope.
      const restrictToOwnerId =
        personaOf(membership.role) === 'sales' ? membership.userId : undefined;
      const links = await resolveDealLinks(
        tenant.id,
        restrictToOwnerId,
        parsed.data.companyId,
        parsed.data.contactId,
      );
      if (!links.ok) {
        return {
          ok: false,
          message: links.message,
          fieldErrors: { [links.field]: [links.message] },
        };
      }

      // Assignment rules (server-enforced): only owner/manager may assign to
      // someone else; a manager may not assign to an owner. Anyone else gets
      // their own new deal.
      let finalOwnerId = parsed.data.ownerId;
      if (finalOwnerId && finalOwnerId !== membership.userId) {
        const canAssign =
          membership.role === 'owner' || membership.role === 'manager';
        if (!canAssign) {
          finalOwnerId = membership.userId;
        } else if (membership.role === 'manager') {
          const targetRole = await getMemberRole(tenant.id, finalOwnerId);
          if (targetRole === 'owner') {
            return {
              ok: false,
              message: 'Managers cannot assign deals to an owner.',
              fieldErrors: { ownerId: ['Pick a non-owner teammate'] },
            };
          }
        }
      }

      const customDefs = await listCustomFieldDefs(tenant.id, 'deal');
      const customResult = parseCustomFields(formData, customDefs);
      if (!customResult.ok) {
        return {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: customFieldErrors(customResult.errors),
        };
      }

      // Per-unit pricing: when both are provided, Amount is derived server-side
      // (never trust the client's amount) and the unit price + qty are stored.
      let amountMinor: number;
      let unitPriceMinor: number | null = null;
      let quantity: number | null = null;
      if (parsed.data.unitPrice !== undefined && parsed.data.quantity !== undefined) {
        unitPriceMinor = toMinorUnits(parsed.data.unitPrice, parsed.data.currency);
        quantity = parsed.data.quantity;
        amountMinor = unitPriceMinor * quantity;
      } else {
        amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
      }
      const marginBps =
        parsed.data.marginPct !== undefined
          ? marginPctToBps(parsed.data.marginPct)
          : null;
      const closedAt =
        parsed.data.stage === 'won' || parsed.data.stage === 'lost'
          ? new Date()
          : null;
      // A deal created directly at Won needs an approval state; anywhere else
      // it's 'none' (schema default). Manager/admin/owner → auto-approved.
      const approval =
        parsed.data.stage === 'won'
          ? approvalOnEnterWon(membership.role, membership.userId, new Date())
          : null;

      const created = await tenantTransaction(async (tx) => {
        const [row] = await tx
          .insert(deals)
          .values({
            tenantId: tenant.id,
            companyId: links.companyId,
            contactId: links.contactId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            stage: parsed.data.stage,
            amountMinor,
            unitPriceMinor,
            quantity,
            marginBps,
            ...(approval && {
              approvalStatus: approval.approvalStatus,
              approvedBy: approval.approvedBy,
              approvedAt: approval.approvedAt,
            }),
            currency: parsed.data.currency,
            expectedCloseDate: parsed.data.expectedCloseDate,
            closedAt,
            ownerId: finalOwnerId ?? null,
            customFields: customResult.values,
            updatedBy: membership.userId,
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
      // Company/Contact are linked records chosen from role-scoped dropdowns.
      const raw: Record<string, FormDataEntryValue | null> = {
        id: formData.get('id'),
        name: formData.get('name'),
        description: formData.get('description'),
        stage: formData.get('stage'),
        amount: formData.get('amount'),
        currency: formData.get('currency'),
        expectedCloseDate: formData.get('expectedCloseDate'),
        companyId: formData.get('companyId') || null,
        contactId: formData.get('contactId') || null,
        unitPrice: formData.get('unitPrice'),
        quantity: formData.get('quantity'),
        marginPct: formData.get('marginPct'),
        ownerId: formData.get('ownerId'),
      };
      for (const key of ['description', 'expectedCloseDate', 'ownerId'] as const) {
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

      const customDefs = await listCustomFieldDefs(tenant.id, 'deal');
      const customResult = parseCustomFields(formData, customDefs);
      if (!customResult.ok) {
        return {
          ok: false,
          message: 'Please fix the highlighted fields.',
          fieldErrors: customFieldErrors(customResult.errors),
        };
      }

      const restrictToOwnerId =
        personaOf(membership.role) === 'sales' ? membership.userId : undefined;
      const links = await resolveDealLinks(
        tenant.id,
        restrictToOwnerId,
        parsed.data.companyId,
        parsed.data.contactId,
      );
      if (!links.ok) {
        return {
          ok: false,
          message: links.message,
          fieldErrors: { [links.field]: [links.message] },
        };
      }

      let amountMinor: number;
      let unitPriceMinor: number | null = null;
      let quantity: number | null = null;
      if (parsed.data.unitPrice !== undefined && parsed.data.quantity !== undefined) {
        unitPriceMinor = toMinorUnits(parsed.data.unitPrice, parsed.data.currency);
        quantity = parsed.data.quantity;
        amountMinor = unitPriceMinor * quantity;
      } else {
        amountMinor = toMinorUnits(parsed.data.amount, parsed.data.currency);
      }
      const marginBps =
        parsed.data.marginPct !== undefined
          ? marginPctToBps(parsed.data.marginPct)
          : null;
      const isClosedStage =
        parsed.data.stage === 'won' || parsed.data.stage === 'lost';

      // Assignment: only owner/manager may change the owner, and a manager may
      // not assign to an owner. For anyone else, leave the owner untouched
      // (their edit form doesn't post an ownerId).
      const canAssign =
        membership.role === 'owner' || membership.role === 'manager';
      let ownerPatch: { ownerId?: string | null } = {};
      if (canAssign) {
        const finalOwnerId = parsed.data.ownerId ?? null;
        if (finalOwnerId && membership.role === 'manager') {
          const targetRole = await getMemberRole(tenant.id, finalOwnerId);
          if (targetRole === 'owner') {
            return {
              ok: false,
              message: 'Managers cannot assign deals to an owner.',
              fieldErrors: { ownerId: ['Pick a non-owner teammate'] },
            };
          }
        }
        ownerPatch = { ownerId: finalOwnerId };
      }

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

        // Approval follows the stage transition: entering Won as a rep →
        // pending, as a manager → approved; leaving Won → cleared. Staying at
        // Won returns null so an unrelated edit never disturbs an approval.
        const approvalPatch = approvalForTransition(
          previous.stage,
          parsed.data.stage,
          membership.role,
          membership.userId,
          new Date(),
        );

        const [updated] = await tx
          .update(deals)
          .set({
            companyId: links.companyId,
            contactId: links.contactId,
            // Linked now — clear any legacy free-text labels.
            companyNameText: null,
            contactNameText: null,
            contactEmailText: null,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            stage: parsed.data.stage,
            amountMinor,
            unitPriceMinor,
            quantity,
            marginBps,
            ...(approvalPatch && {
              approvalStatus: approvalPatch.approvalStatus,
              approvedBy: approvalPatch.approvedBy,
              approvedAt: approvalPatch.approvedAt,
            }),
            currency: parsed.data.currency,
            expectedCloseDate: parsed.data.expectedCloseDate,
            closedAt: nextClosedAt,
            customFields: customResult.values,
            updatedBy: membership.userId,
            ...ownerPatch,
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

        // Manager-approval gate: moving to Won as a rep → pending; as a
        // manager/admin/owner → auto-approved. Moving away from Won clears it.
        const approvalPatch = approvalForTransition(
          previous.stage,
          parsed.data.stage,
          membership.role,
          membership.userId,
          new Date(),
        );

        const [updated] = await tx
          .update(deals)
          .set({
            stage: parsed.data.stage,
            closedAt: nextClosedAt,
            ...(approvalPatch && {
              approvalStatus: approvalPatch.approvalStatus,
              approvedBy: approvalPatch.approvedBy,
              approvedAt: approvalPatch.approvedAt,
            }),
            updatedBy: membership.userId,
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

/* -------- APPROVE / REJECT (manager gate at Won) -------- */

/**
 * Approve a Won deal that is awaiting manager sign-off. Only valid when the
 * deal is currently at the Won stage and 'pending'. Approval is what makes a
 * won deal count toward sales-target achievement.
 */
export async function approveDealAction(id: string): Promise<SimpleResult> {
  const gate = await checkPermission('approveDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsedId = dealIdSchema.safeParse({ id });
  if (!parsedId.success) return { ok: false, message: 'Invalid deal id.' };

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const ok = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select({
            id: deals.id,
            name: deals.name,
            stage: deals.stage,
            approvalStatus: deals.approvalStatus,
          })
          .from(deals)
          .where(
            and(
              eq(deals.id, parsedId.data.id),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return false;
        if (previous.stage !== 'won' || previous.approvalStatus !== 'pending') {
          return false;
        }

        const [updated] = await tx
          .update(deals)
          .set({
            approvalStatus: 'approved',
            approvedBy: membership.userId,
            approvedAt: new Date(),
            updatedBy: membership.userId,
          })
          .where(and(eq(deals.id, previous.id), eq(deals.tenantId, tenant.id)))
          .returning();
        if (!updated) return false;

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: updated.id,
          action: 'deal_approved',
          metadata: { name: updated.name },
        });

        const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.updated',
            tenantId: tenant.id,
            deal: serialized,
          });
        }
        return true;
      });

      if (!ok) {
        return {
          ok: false,
          message: 'This deal is not awaiting approval.',
        };
      }
      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath(`/dashboard/deals/${parsedId.data.id}`);
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/**
 * Reject a Won deal awaiting sign-off. Per the agreed model this REOPENS the
 * deal to the Negotiation stage (clears the win + closedAt) so the rep can
 * rework it; the rejection is recorded for audit.
 */
export async function rejectDealAction(input: {
  id: string;
  reason?: string;
}): Promise<SimpleResult> {
  const gate = await checkPermission('approveDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsedId = dealIdSchema.safeParse({ id: input.id });
  if (!parsedId.success) return { ok: false, message: 'Invalid deal id.' };
  const reason =
    typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim().slice(0, 500)
      : null;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const ok = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select({
            id: deals.id,
            name: deals.name,
            stage: deals.stage,
            approvalStatus: deals.approvalStatus,
          })
          .from(deals)
          .where(
            and(
              eq(deals.id, parsedId.data.id),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return false;
        if (previous.stage !== 'won' || previous.approvalStatus !== 'pending') {
          return false;
        }

        const [updated] = await tx
          .update(deals)
          .set({
            stage: 'negotiation',
            closedAt: null,
            approvalStatus: 'rejected',
            approvedBy: membership.userId,
            approvedAt: new Date(),
            updatedBy: membership.userId,
          })
          .where(and(eq(deals.id, previous.id), eq(deals.tenantId, tenant.id)))
          .returning();
        if (!updated) return false;

        await recordActivity(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          entityType: 'deal',
          entityId: updated.id,
          action: 'deal_rejected',
          metadata: { name: updated.name, ...(reason && { reason }) },
        });

        const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.stage_changed',
            tenantId: tenant.id,
            deal: serialized,
            from: 'won',
            to: 'negotiation',
          });
        }
        return true;
      });

      if (!ok) {
        return { ok: false, message: 'This deal is not awaiting approval.' };
      }
      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath(`/dashboard/deals/${parsedId.data.id}`);
      revalidatePath('/dashboard/activity');
      return { ok: true };
    },
  );
}

/* -------- BULK APPROVE / REJECT -------- */

const bulkIdsSchema = z.object({
  ids: z.array(z.uuid()).min(1, 'Select at least one deal').max(200),
});

export type BulkApprovalResult =
  | { ok: true; count: number }
  | { ok: false; message: string };

/**
 * Approve many pending Won deals at once. Skips any id that isn't currently
 * Won + pending. Returns how many were actually approved.
 */
export async function bulkApproveDealsAction(
  ids: string[],
): Promise<BulkApprovalResult> {
  const gate = await checkPermission('approveDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const parsed = bulkIdsSchema.safeParse({ ids });
  if (!parsed.success) return { ok: false, message: 'No deals selected.' };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const count = await tenantTransaction(async (tx) => {
        let n = 0;
        for (const id of parsed.data.ids) {
          const [previous] = await tx
            .select({
              id: deals.id,
              name: deals.name,
              stage: deals.stage,
              approvalStatus: deals.approvalStatus,
            })
            .from(deals)
            .where(
              and(
                eq(deals.id, id),
                eq(deals.tenantId, tenant.id),
                isNull(deals.deletedAt),
              ),
            )
            .limit(1);
          if (
            !previous ||
            previous.stage !== 'won' ||
            previous.approvalStatus !== 'pending'
          ) {
            continue;
          }
          const [updated] = await tx
            .update(deals)
            .set({
              approvalStatus: 'approved',
              approvedBy: membership.userId,
              approvedAt: new Date(),
              updatedBy: membership.userId,
            })
            .where(and(eq(deals.id, id), eq(deals.tenantId, tenant.id)))
            .returning();
          if (!updated) continue;
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: updated.id,
            action: 'deal_approved',
            metadata: { name: updated.name },
          });
          const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);
          if (serialized) {
            await publishRealtimeEvent(tx, {
              type: 'deal.updated',
              tenantId: tenant.id,
              deal: serialized,
            });
          }
          n++;
        }
        return n;
      });

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/deals/approvals');
      revalidatePath('/dashboard/activity');
      return { ok: true, count };
    },
  );
}

/**
 * Reject many pending Won deals at once — each is reopened to Negotiation.
 * Skips any id that isn't currently Won + pending.
 */
export async function bulkRejectDealsAction(input: {
  ids: string[];
  reason?: string;
}): Promise<BulkApprovalResult> {
  const gate = await checkPermission('approveDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const parsed = bulkIdsSchema.safeParse({ ids: input.ids });
  if (!parsed.success) return { ok: false, message: 'No deals selected.' };
  const { tenant, membership } = gate;
  const reason =
    typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim().slice(0, 500)
      : null;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const count = await tenantTransaction(async (tx) => {
        let n = 0;
        for (const id of parsed.data.ids) {
          const [previous] = await tx
            .select({
              id: deals.id,
              name: deals.name,
              stage: deals.stage,
              approvalStatus: deals.approvalStatus,
            })
            .from(deals)
            .where(
              and(
                eq(deals.id, id),
                eq(deals.tenantId, tenant.id),
                isNull(deals.deletedAt),
              ),
            )
            .limit(1);
          if (
            !previous ||
            previous.stage !== 'won' ||
            previous.approvalStatus !== 'pending'
          ) {
            continue;
          }
          const [updated] = await tx
            .update(deals)
            .set({
              stage: 'negotiation',
              closedAt: null,
              approvalStatus: 'rejected',
              approvedBy: membership.userId,
              approvedAt: new Date(),
              updatedBy: membership.userId,
            })
            .where(and(eq(deals.id, id), eq(deals.tenantId, tenant.id)))
            .returning();
          if (!updated) continue;
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: updated.id,
            action: 'deal_rejected',
            metadata: { name: updated.name, ...(reason && { reason }) },
          });
          const serialized = await loadSerializedDeal(tx, tenant.id, updated.id);
          if (serialized) {
            await publishRealtimeEvent(tx, {
              type: 'deal.stage_changed',
              tenantId: tenant.id,
              deal: serialized,
              from: 'won',
              to: 'negotiation',
            });
          }
          n++;
        }
        return n;
      });

      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      revalidatePath('/dashboard/deals/approvals');
      revalidatePath('/dashboard/activity');
      return { ok: true, count };
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

/* -------- INLINE PATCH (click-to-edit cells) -------- */

export type PatchDealResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Apply a partial field update to a deal — backs inline table editing. Only
 * the provided keys are written; `null` clears nullable fields. Reuses the
 * same RBAC as full edits (manageDeals), gates owner reassignment like
 * `updateDealOwnerAction`, and emits a realtime `deal.updated` so the board /
 * other clients reconcile.
 */
export async function patchDealAction(
  input: unknown,
): Promise<PatchDealResult> {
  const gate = await checkPermission('manageDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  const parsed = patchDealSchema.safeParse(input);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error);
    const first =
      flat.formErrors[0] ??
      Object.values(flat.fieldErrors).flat()[0] ??
      'Invalid update.';
    return { ok: false, message: first };
  }
  const d = parsed.data;

  // Owner reassignment is owner/manager only; a manager can't assign to owner.
  if (d.ownerId !== undefined) {
    const canAssign =
      membership.role === 'owner' || membership.role === 'manager';
    if (!canAssign) return { ok: false, message: 'You cannot reassign deals.' };
    if (membership.role === 'manager' && d.ownerId) {
      const targetRole = await getMemberRole(tenant.id, d.ownerId);
      if (targetRole === 'owner') {
        return { ok: false, message: 'Managers cannot assign deals to an owner.' };
      }
    }
  }

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      // Amount is derived (unit price × qty) either when the workspace has
      // per-unit pricing on, OR when this deal already carries a unit price +
      // qty (kept even after the toggle is turned off). In both cases a direct
      // amount patch is rejected so it can never desync.
      const settingsUnitPricing =
        d.amount !== undefined
          ? (await getOrgSettings(tenant.id)).dealUnitPricingEnabled
          : false;

      // Resolve linked company/contact (tenant + role scope) before the write.
      let linkPatch: Record<string, unknown> = {};
      if (d.companyId !== undefined || d.contactId !== undefined) {
        const restrictToOwnerId =
          personaOf(membership.role) === 'sales' ? membership.userId : undefined;
        const links = await resolveDealLinks(
          tenant.id,
          restrictToOwnerId,
          d.companyId ?? null,
          d.contactId ?? null,
        );
        if (!links.ok) return { ok: false, message: links.message };
        linkPatch = {
          companyId: links.companyId,
          contactId: links.contactId,
          companyNameText: null,
          contactNameText: null,
          contactEmailText: null,
        };
      }

      let updated: typeof deals.$inferSelect | null;
      try {
        updated = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(deals)
          .where(
            and(
              eq(deals.id, d.id),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .limit(1);
        if (!previous) return null;

        if (
          d.amount !== undefined &&
          (settingsUnitPricing ||
            (previous.unitPriceMinor != null && previous.quantity != null))
        ) {
          throw new Error('AMOUNT_DERIVED');
        }

        const patch: Record<string, unknown> = { ...linkPatch };
        if (d.name !== undefined) patch.name = d.name;
        if (d.expectedCloseDate !== undefined)
          patch.expectedCloseDate = d.expectedCloseDate;
        if (d.companyName !== undefined)
          patch.companyNameText = d.companyName?.trim() ? d.companyName.trim() : null;
        if (d.contactName !== undefined)
          patch.contactNameText = d.contactName?.trim() ? d.contactName.trim() : null;
        if (d.contactEmail !== undefined)
          patch.contactEmailText = d.contactEmail?.trim() ? d.contactEmail.trim() : null;
        if (d.ownerId !== undefined) patch.ownerId = d.ownerId;
        if (d.currency !== undefined) patch.currency = d.currency;
        if (d.amount !== undefined) {
          patch.amountMinor = toMinorUnits(d.amount, d.currency ?? previous.currency);
        }
        if (Object.keys(patch).length === 0) return previous;
        patch.updatedBy = membership.userId;

        const [row] = await tx
          .update(deals)
          .set(patch)
          .where(
            and(
              eq(deals.id, d.id),
              eq(deals.tenantId, tenant.id),
              isNull(deals.deletedAt),
            ),
          )
          .returning();
        if (!row) return null;

        if (
          d.ownerId !== undefined &&
          (previous.ownerId ?? null) !== (row.ownerId ?? null)
        ) {
          await recordActivity(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            entityType: 'deal',
            entityId: row.id,
            action: 'owner_changed',
            metadata: {
              name: row.name,
              from: previous.ownerId ?? null,
              to: row.ownerId ?? null,
            },
          });
        }

        const serialized = await loadSerializedDeal(tx, tenant.id, row.id);
        if (serialized) {
          await publishRealtimeEvent(tx, {
            type: 'deal.updated',
            tenantId: tenant.id,
            deal: serialized,
          });
        }
        return row;
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'AMOUNT_DERIVED') {
          return {
            ok: false,
            message: 'Amount is set by Per Unit Price × Qty on the deal.',
          };
        }
        throw err;
      }

      if (!updated) return { ok: false, message: 'Deal not found.' };
      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
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
  // Assigning deal ownership is owner/manager only (members can't reassign).
  const gate = await checkPermission('assignDeals');
  if (!gate.ok) return { ok: false, message: gate.message };
  const { tenant, membership } = gate;

  return await runWithTenantContext(
    { tenantId: tenant.id, userId: membership.userId },
    async () => {
      const parsed = updateOwnerSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, message: 'Invalid owner payload' };
      }

      // A manager may not assign a deal to an owner.
      if (membership.role === 'manager' && parsed.data.ownerId) {
        const targetRole = await getMemberRole(tenant.id, parsed.data.ownerId);
        if (targetRole === 'owner') {
          return { ok: false, message: 'Managers cannot assign deals to an owner.' };
        }
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
          .set({ ownerId: parsed.data.ownerId, updatedBy: membership.userId })
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
 * Header aliases tolerated (see normalizeHeader). The company column is
 * stored as a free-text label on the deal (same as the create form) — it
 * is not matched to or created as a company record.
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

        // Company is a free-text label (matches the deal form) — store as
        // typed; no record lookup or creation.
        const companyNameText = cell('companyName') || null;

        const description = cell('description') || null;
        const isClosedStage = stage === 'won' || stage === 'lost';

        toInsert.push({
          tenantId: tenant.id,
          companyId: null,
          companyNameText,
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
