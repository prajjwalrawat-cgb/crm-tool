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
import {
  blockMessage,
  checkGateAndLogWarnings,
  enforceGateOrThrow,
  GateBlockedError,
} from '@/lib/stage-gates/enforce';
import { evaluateStageTransition } from '@/lib/stage-gates/evaluate';
import { type GateFailure } from '@/lib/stage-gates/types';
import { queueDealScoreRecompute } from '@/lib/deals/scoring/queue';
import { deriveForecastCategory } from '@/lib/deals/forecast/categories';
import {
  buildDealColumnPatch,
  UnitPricingIncompleteError,
} from '@/lib/deals/patch-columns';
import {
  clearCloseDateReason,
  setCloseDateReason,
} from '@/lib/deals/close-date-reason';
import {
  clearStageChangeReason,
  isCloseDateRequiredError,
  isRollbackReasonRequiredError,
  setStageChangeReason,
} from '@/lib/deals/stage-change-reason';
import {
  CLOSE_DATE_CLEAR_BLOCKED_MESSAGE,
  closeDateRequiredMessage,
  isRollbackTransition,
  ROLLBACK_REASON_REQUIRED_MESSAGE,
  ROLLBACK_REASONS,
  SYSTEM_ROLLBACK_REASONS,
  violatesCloseDateClear,
  violatesMissingCloseDate,
} from '@/lib/deals/stage-governance';
import { HOLD_REASONS } from '@/lib/deals/hold';
import {
  LEAD_CLOSE_DATE_MESSAGE,
  MARGIN_REQUIRED_MESSAGE,
  marginRequiredForStage,
  violatesLeadCloseDate,
} from '@/lib/deals/validation';
import {
  insertDealOfferings,
  OfferingSyncError,
  resolveOfferingIds,
  syncDealOfferings,
} from '@/lib/offerings/queries';
import {
  OFFERINGS_REQUIRED_MESSAGE,
  validateOfferingSelection,
} from '@/lib/offerings/types';
import { personaOf } from '@/lib/personas';
import { canApproveDeals } from '@/lib/rbac';
import { loadSerializedDeal } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

export type CreateDealResult =
  | { ok: true; deal: Deal }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
      // Set when a stage gate blocked creating the deal directly at a gated stage.
      blocked?: true;
      failures?: GateFailure[];
      toStage?: string;
    };

export type UpdateDealResult =
  | { ok: true; deal: Deal }
  | {
      ok: false;
      message: string;
      fieldErrors?: Record<string, string[]>;
      // Set when a stage gate blocked a stage change made via the edit form.
      blocked?: true;
      failures?: GateFailure[];
      toStage?: string;
    };

export type SimpleResult =
  | { ok: true }
  | { ok: false; message: string };

/** Thrown when the edit form tries to enter Hold (Module 6) — needs the board. */
class HoldEditError extends Error {}

/**
 * Thrown inside the create transaction when every offering the form sent has
 * since been retired (or never belonged to this tenant). A throw rather than
 * an early return because we are already inside `tenantTransaction` and the
 * deal insert must roll back with it.
 */
class OfferingsUnavailableError extends Error {}

/**
 * Read the offerings picker's two hidden inputs. The field submits a
 * comma-joined id list and a single primary id; see `OfferingsField` for why
 * hidden inputs rather than a native multi-select.
 */
function parseOfferingSelection(formData: FormData): {
  offeringIds: string[];
  primaryOfferingId: string | null;
} {
  return {
    offeringIds: String(formData.get('offeringIds') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    primaryOfferingId:
      String(formData.get('primaryOfferingId') ?? '').trim() || null,
  };
}

/**
 * R3 — thrown inside the update transaction when a save would blank an
 * existing close date on a deal staying in Proposal/Negotiation/Won. Thrown
 * rather than returned so the write rolls back atomically, matching how
 * `HoldEditError` and `GateBlockedError` already work here.
 */
class CloseDateClearError extends Error {}

/** R2 — thrown when a backward stage move arrives with no reason code. */
class RollbackReasonError extends Error {
  readonly fromStage: string;
  constructor(fromStage: string) {
    super(ROLLBACK_REASON_REQUIRED_MESSAGE);
    this.name = 'RollbackReasonError';
    this.fromStage = fromStage;
  }
}

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
  const ctId = contactId;

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
  }
  // A contact may be linked WITHOUT a company (an individual customer). We no
  // longer force ctId = null here; the contact is validated below on its own.

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
        dealType: formData.get('dealType'),
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

      // Business rule: a dated deal can't be created in Lead.
      if (violatesLeadCloseDate(parsed.data.stage, parsed.data.expectedCloseDate)) {
        return {
          ok: false,
          message: LEAD_CLOSE_DATE_MESSAGE,
          fieldErrors: { stage: [LEAD_CLOSE_DATE_MESSAGE] },
        };
      }

      // R1 — a deal can't be born straight into Proposal/Negotiation/Won
      // without a close date either. Checked here as well as by the DB
      // constraint so the user gets a field error, not a failed insert.
      if (
        violatesMissingCloseDate(parsed.data.stage, parsed.data.expectedCloseDate)
      ) {
        const message = closeDateRequiredMessage(parsed.data.stage);
        return {
          ok: false,
          message,
          fieldErrors: { expectedCloseDate: [message] },
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

      // Offerings (0066) — mandatory on CREATE, and enforced here as well as
      // in the form, because the form check is a courtesy (it saves a
      // round-trip that would blank the Company/Contact selects) and this is
      // the rule. Update has no equivalent block: legacy deals are untagged
      // and must stay editable. See `validateOfferingSelection`.
      const offeringSelection = validateOfferingSelection(
        parseOfferingSelection(formData),
      );
      if (!offeringSelection.ok) {
        return {
          ok: false,
          message: offeringSelection.message,
          fieldErrors: { offeringIds: [offeringSelection.message] },
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
      // Absent only when the deal is in a stage that doesn't require a margin
      // (Lead/Hold/Lost — the schema enforces that); NULL means "not known yet".
      const marginBps =
        parsed.data.marginPct === undefined
          ? null
          : marginPctToBps(parsed.data.marginPct);
      const lostReason =
        parsed.data.stage === 'lost'
          ? String(formData.get('lostReason') ?? '').trim().slice(0, 1000) || null
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

      let created: Deal | null;
      try {
        created = await tenantTransaction(async (tx) => {
        // Stage-gate enforcement for a deal created directly above Lead — treat
        // it as a lead→stage transition. Count-based rules (stakeholders /
        // activities) see 0 since the deal doesn't exist yet, so a deal can't be
        // born past a gate it hasn't earned; create at Lead and advance instead.
        if (parsed.data.stage !== 'lead') {
          await enforceGateOrThrow(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            dealId: null,
            dealName: parsed.data.name,
            fromStage: 'lead',
            toStage: parsed.data.stage,
            override: {
              contactId: links.contactId,
              companyId: links.companyId,
              amountMinor,
              currency: parsed.data.currency,
              expectedCloseDate: parsed.data.expectedCloseDate ?? null,
              dealType: parsed.data.dealType ?? null,
              description: parsed.data.description ?? null,
              customFields: customResult.values,
            },
          });
        }

        const [row] = await tx
          .insert(deals)
          .values({
            tenantId: tenant.id,
            companyId: links.companyId,
            contactId: links.contactId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            stage: parsed.data.stage,
            dealType: parsed.data.dealType ?? null,
            amountMinor,
            unitPriceMinor,
            quantity,
            marginBps,
            lostReason,
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
            // Forecast category auto-derived from the starting stage (Module 4).
            forecastCategory: deriveForecastCategory(parsed.data.stage),
            updatedBy: membership.userId,
          })
          .returning();
        if (!row) return null;

        // Tags land in the SAME transaction as the deal. A deal that
        // committed while its offerings failed would be exactly the untagged
        // row the mandatory field exists to prevent — and it would be
        // invisible, since nothing would ever prompt for it again.
        //
        // `resolveOfferingIds` re-checks the ids against this tenant and
        // against `active`, so a stale form (an offering retired while the
        // drawer was open) fails with a sentence instead of a raw FK error.
        const offeringIds = await resolveOfferingIds(
          tx,
          tenant.id,
          parseOfferingSelection(formData).offeringIds,
        );
        if (offeringIds.length === 0) {
          throw new OfferingsUnavailableError(OFFERINGS_REQUIRED_MESSAGE);
        }
        await insertDealOfferings(tx, {
          tenantId: tenant.id,
          dealId: row.id,
          offeringIds,
          primaryOfferingId: offeringSelection.primaryOfferingId,
        });

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
      } catch (err) {
        if (err instanceof GateBlockedError) {
          return {
            ok: false,
            message: err.message,
            blocked: true,
            failures: err.failures,
            toStage: err.toStage,
          };
        }
        if (err instanceof OfferingsUnavailableError) {
          return {
            ok: false,
            message: err.message,
            fieldErrors: { offeringIds: [err.message] },
          };
        }
        throw err;
      }

      if (!created) return { ok: false, message: 'Failed to create deal.' };

      await sendWorkflowEvent('crm/deal.created', {
        tenantId: tenant.id,
        dealId: created.id,
        actorUserId: membership.userId,
        name: created.name,
        stage: created.stage,
      });
      await queueDealScoreRecompute(tenant.id, created.id, 'created');
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
        dealType: formData.get('dealType'),
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

      // Business rule: a dated deal can't be saved in Lead.
      if (violatesLeadCloseDate(parsed.data.stage, parsed.data.expectedCloseDate)) {
        return {
          ok: false,
          message: LEAD_CLOSE_DATE_MESSAGE,
          fieldErrors: { stage: [LEAD_CLOSE_DATE_MESSAGE] },
        };
      }

      // R1 — and its bookend: Proposal / Negotiation / Won must carry a date.
      // Filed against `expectedCloseDate` so the form highlights the input the
      // user has to fill, not the stage they just chose.
      if (
        violatesMissingCloseDate(parsed.data.stage, parsed.data.expectedCloseDate)
      ) {
        const message = closeDateRequiredMessage(parsed.data.stage);
        return {
          ok: false,
          message,
          fieldErrors: { expectedCloseDate: [message] },
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
      // Absent only when the deal is in a stage that doesn't require a margin
      // (Lead/Hold/Lost — the schema enforces that); NULL means "not known yet".
      const marginBps =
        parsed.data.marginPct === undefined
          ? null
          : marginPctToBps(parsed.data.marginPct);
      const isClosedStage =
        parsed.data.stage === 'won' || parsed.data.stage === 'lost';
      // Lost reason from the edit form; only kept while the deal is 'lost'.
      const lostReason =
        parsed.data.stage === 'lost'
          ? String(formData.get('lostReason') ?? '').trim().slice(0, 1000) || null
          : null;

      // R2 — rollback reason posted alongside the fields. Read here (rather
      // than via the schema) for the same reason `lostReason` is: whether it's
      // required depends on the deal's CURRENT stage, which isn't known until
      // the row is read inside the transaction.
      const rollbackReasonRaw = String(formData.get('rollbackReason') ?? '').trim();
      const rollbackReason = (ROLLBACK_REASONS as readonly string[]).includes(
        rollbackReasonRaw,
      )
        ? rollbackReasonRaw
        : null;
      const rollbackNote =
        String(formData.get('rollbackNote') ?? '').trim().slice(0, 1000) || null;

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

      let result: Deal | null;
      try {
        result = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select({
            id: deals.id,
            stage: deals.stage,
            name: deals.name,
            closedAt: deals.closedAt,
            expectedCloseDate: deals.expectedCloseDate,
            forecastCategoryOverridden: deals.forecastCategoryOverridden,
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

        // Module 6: entering Hold needs a reason + revisit date, which the edit
        // form doesn't collect — send the user to the board for that move.
        if (parsed.data.stage === 'hold' && previous.stage !== 'hold') {
          throw new HoldEditError();
        }

        // R3 — an existing close date can't be blanked while the deal stays in
        // a date-required stage. Replacing it with a later one is a pushback
        // (R4, logged and counted) and is allowed; emptying the field is not.
        // Evaluated against the stage being SAVED, so an edit that rolls the
        // deal back to Lead/Qualified and drops the date in one submit is a
        // legitimate rollback rather than a silent deletion.
        if (
          violatesCloseDateClear({
            nextStage: parsed.data.stage,
            previousCloseDate: previous.expectedCloseDate,
            nextCloseDate: parsed.data.expectedCloseDate,
          })
        ) {
          throw new CloseDateClearError();
        }

        // R2 — a backward stage move from the edit form needs a reason code,
        // exactly as a backward drag on the board does. The form posts one
        // alongside the fields (see the rollback prompt in deal-form).
        const rollingBack = isRollbackTransition(
          previous.stage,
          parsed.data.stage,
        );
        if (rollingBack) {
          if (!rollbackReason) throw new RollbackReasonError(previous.stage);
          await setStageChangeReason(tx, {
            code: rollbackReason,
            note: rollbackNote,
          });
        }

        // Stage-gate enforcement when the edit changes the stage. The gate is
        // evaluated against the values being SAVED (override) so setting the
        // amount/contact and advancing in one submit is not wrongly blocked.
        if (previous.stage !== parsed.data.stage) {
          await enforceGateOrThrow(tx, {
            tenantId: tenant.id,
            actorUserId: membership.userId,
            dealId: previous.id,
            dealName: previous.name,
            fromStage: previous.stage,
            toStage: parsed.data.stage,
            override: {
              contactId: links.contactId,
              companyId: links.companyId,
              amountMinor,
              currency: parsed.data.currency,
              expectedCloseDate: parsed.data.expectedCloseDate ?? null,
              dealType: parsed.data.dealType ?? null,
              description: parsed.data.description ?? null,
              customFields: customResult.values,
            },
          });
        }

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
            dealType: parsed.data.dealType ?? null,
            amountMinor,
            unitPriceMinor,
            quantity,
            marginBps,
            lostReason,
            ...(approvalPatch && {
              approvalStatus: approvalPatch.approvalStatus,
              approvedBy: approvalPatch.approvedBy,
              approvedAt: approvalPatch.approvedAt,
            }),
            currency: parsed.data.currency,
            expectedCloseDate: parsed.data.expectedCloseDate,
            closedAt: nextClosedAt,
            customFields: customResult.values,
            // Re-derive forecast category if the stage changed and it isn't
            // manually overridden (Module 4).
            ...(previous.stage !== parsed.data.stage &&
            !previous.forecastCategoryOverridden
              ? { forecastCategory: deriveForecastCategory(parsed.data.stage) }
              : {}),
            // Module 6: clear hold fields when the edit moves the deal off Hold.
            ...(previous.stage === 'hold' && parsed.data.stage !== 'hold'
              ? { holdReason: null, holdRevisitOn: null, holdNote: null }
              : {}),
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
        // Reset immediately after the write so nothing later in this
        // transaction (or a retry of it) inherits the rollback reason.
        if (rollingBack) await clearStageChangeReason(tx);
        if (!updated) return null;

        // Offerings (0066) — reconcile the drawer's selection in the same
        // transaction as the deal write, and BEFORE the realtime payload is
        // built, so subscribers get the row with its new tags rather than a
        // card that reverts its chip until the next reload.
        //
        // `syncDealOfferings` owns the rules: a retired tag already on the
        // deal survives, a tagged deal can't be emptied, an untagged legacy
        // deal is left alone.
        await syncDealOfferings(tx, {
          tenantId: tenant.id,
          dealId: updated.id,
          ...parseOfferingSelection(formData),
        });

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
              ...(lostReason && { reason: lostReason }),
              ...(rollingBack && {
                rollback: true,
                rollbackReason,
                ...(rollbackNote && { rollbackNote }),
              }),
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
      } catch (err) {
        if (err instanceof GateBlockedError) {
          return {
            ok: false,
            message: err.message,
            blocked: true,
            failures: err.failures,
            toStage: err.toStage,
          };
        }
        if (err instanceof HoldEditError) {
          return {
            ok: false,
            message:
              'Put a deal on Hold from the pipeline board — it needs a reason and a revisit date.',
          };
        }
        // R3 — filed against the date input the user emptied.
        if (err instanceof CloseDateClearError) {
          return {
            ok: false,
            message: CLOSE_DATE_CLEAR_BLOCKED_MESSAGE,
            fieldErrors: { expectedCloseDate: [CLOSE_DATE_CLEAR_BLOCKED_MESSAGE] },
          };
        }
        // R2 — the form re-submits with a reason once the user picks one.
        if (err instanceof RollbackReasonError) {
          return {
            ok: false,
            message: ROLLBACK_REASON_REQUIRED_MESSAGE,
            fieldErrors: { rollbackReason: [ROLLBACK_REASON_REQUIRED_MESSAGE] },
          };
        }
        // Offerings (0066): emptied a tagged deal, or picked one that has
        // since been retired. Filed against the picker so the drawer
        // highlights it rather than showing a bare banner.
        if (err instanceof OfferingSyncError) {
          return {
            ok: false,
            message: err.message,
            fieldErrors: { offeringIds: [err.message] },
          };
        }
        // The DB backstops both rules (0060). Reaching here means a path
        // slipped past the checks above, or the deal predates the NOT VALID
        // constraint — either way, an actionable message beats a raw error.
        if (isRollbackReasonRequiredError(err)) {
          return { ok: false, message: ROLLBACK_REASON_REQUIRED_MESSAGE };
        }
        if (isCloseDateRequiredError(err)) {
          const message = closeDateRequiredMessage(parsed.data.stage);
          return {
            ok: false,
            message,
            fieldErrors: { expectedCloseDate: [message] },
          };
        }
        throw err;
      }

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
      await queueDealScoreRecompute(tenant.id, result.id, 'deal_updated');

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
  // Free-text reason captured when moving a deal to 'lost'.
  reason: z.string().max(1000).optional(),
  // Justification captured for a `custom_note` stage gate on the target stage.
  gateNote: z.string().max(2000).optional(),
  // Module 6 — required when moving to 'hold'.
  holdReason: z.enum(HOLD_REASONS).optional(),
  holdRevisitOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional(),
  holdNote: z.string().max(1000).optional(),
  // Set when the user has been told, and accepted, that moving back to Lead
  // drops the deal's close date. Without it a dated deal is refused.
  clearCloseDate: z.boolean().optional(),
  // R2 — mandatory when the move is backward through the ranked funnel. The
  // code is a closed vocabulary so rollbacks are countable; the note is the
  // optional free-text elaboration.
  rollbackReason: z.enum(ROLLBACK_REASONS).optional(),
  rollbackNote: z.string().max(1000).optional(),
});

export type UpdateDealStageInput = {
  id: string;
  stage: string;
  reason?: string;
  gateNote?: string;
  holdReason?: string;
  holdRevisitOn?: string;
  holdNote?: string;
  clearCloseDate?: boolean;
  rollbackReason?: string;
  rollbackNote?: string;
};

export type UpdateDealStageResult =
  | { ok: true; deal: Deal; changed: boolean }
  | {
      ok: false;
      message: string;
      // Set when a stage gate blocked the move — drives the board slide-over.
      blocked?: true;
      failures?: GateFailure[];
      toStage?: string;
      // Move to Lead refused only because the deal is dated. The caller should
      // confirm with the user and retry with `clearCloseDate: true`.
      needsCloseDateClear?: true;
      // R2 — the move is backward and no reason code was supplied. The caller
      // should prompt for one and retry with `rollbackReason`. Carries the
      // stages so the modal can name the move it's asking about.
      needsRollbackReason?: true;
      fromStage?: string;
      // R1 — the target stage requires a close date the deal doesn't have.
      // The caller should send the user to the deal to set one; a bare stage
      // move has no field to put it in.
      needsCloseDate?: true;
    };

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

      // Module 6: moving to Hold requires a reason code + a revisit date.
      if (parsed.data.stage === 'hold') {
        if (!parsed.data.holdReason || !parsed.data.holdRevisitOn) {
          return {
            ok: false,
            message: 'Moving to Hold needs a reason and a revisit date.',
          };
        }
      }

      // Business rule: a dated deal can't sit in Lead. Rather than a dead end,
      // the move is offered as a trade — drop the date and go back. The caller
      // confirms with the user, then retries with `clearCloseDate`.
      if (parsed.data.stage === 'lead' && !parsed.data.clearCloseDate) {
        const [d] = await tenantTransaction((tx) =>
          tx
            .select({ ecd: deals.expectedCloseDate })
            .from(deals)
            .where(
              and(
                eq(deals.id, parsed.data.id),
                eq(deals.tenantId, tenant.id),
                isNull(deals.deletedAt),
              ),
            )
            .limit(1),
        );
        if (d?.ecd) {
          return {
            ok: false,
            message: LEAD_CLOSE_DATE_MESSAGE,
            needsCloseDateClear: true,
          };
        }
      }

      // One shape for every branch of the transaction below, so a governance
      // rejection and a gate rejection stay comparable at the call site
      // instead of forming an awkward inferred union.
      type StageTxResult = {
        row: Deal | null;
        changed: boolean;
        previousStage: Deal['stage'] | null;
        blocked: {
          message: string;
          failures: GateFailure[];
          toStage: Deal['stage'];
        } | null;
        needsRollbackReason?: true;
        needsCloseDate?: true;
      };

      const result: StageTxResult = await tenantTransaction(async (tx) => {
        const [previous] = await tx
          .select({
            id: deals.id,
            stage: deals.stage,
            name: deals.name,
            closedAt: deals.closedAt,
            marginBps: deals.marginBps,
            expectedCloseDate: deals.expectedCloseDate,
            forecastCategoryOverridden: deals.forecastCategoryOverridden,
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
          return { row: null, changed: false, previousStage: null, blocked: null };
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
            blocked: null,
          };
        }

        // R2 — a backward move through the funnel needs a reason code before
        // anything is written. Checked here (not only in the trigger) so the
        // board can open its reason modal and retry, rather than surfacing a
        // database error. Parking in Hold and closing as Lost are not
        // rollbacks: they carry their own reason fields already.
        const rollingBack = isRollbackTransition(
          previous.stage,
          parsed.data.stage,
        );
        if (rollingBack && !parsed.data.rollbackReason) {
          return {
            row: null,
            changed: false,
            previousStage: previous.stage,
            blocked: null,
            needsRollbackReason: true as const,
          };
        }

        // R1 — Proposal / Negotiation / Won require a close date. A pure stage
        // move carries no date field, so a dateless deal can't advance here;
        // reported so the caller can send the user to the deal to set one.
        // Deliberately evaluated against the date the deal will END UP with:
        // a move to Lead clears it, and Lead doesn't require one anyway.
        const closeDateAfterMove =
          parsed.data.stage === 'lead' ? null : previous.expectedCloseDate;
        if (violatesMissingCloseDate(parsed.data.stage, closeDateAfterMove)) {
          return {
            row: null,
            changed: false,
            previousStage: previous.stage,
            blocked: null,
            needsCloseDate: true as const,
          };
        }

        // Business rule: every stage from Qualified onwards carries a margin.
        // A pure stage move can't supply one, so the move is refused — reported
        // in the gate-failure shape so the board renders its checklist
        // slide-over (with a link to the deal) instead of a bare toast.
        if (
          marginRequiredForStage(parsed.data.stage) &&
          previous.marginBps == null
        ) {
          return {
            row: null,
            changed: false,
            previousStage: previous.stage,
            blocked: {
              message: MARGIN_REQUIRED_MESSAGE,
              failures: [
                {
                  rule_type: 'field_required' as const,
                  severity: 'block' as const,
                  message: MARGIN_REQUIRED_MESSAGE,
                  cta: {
                    label: 'Set margin',
                    kind: 'field' as const,
                    field: 'marginPct',
                  },
                },
              ],
              toStage: parsed.data.stage,
            },
          };
        }

        // Stage-gate enforcement: a pure stage move (no field edits ride along)
        // is evaluated against the deal's current field values. A blocked move
        // returns without writing — nothing to roll back.
        const gate = await checkGateAndLogWarnings(tx, {
          tenantId: tenant.id,
          actorUserId: membership.userId,
          dealId: previous.id,
          dealName: previous.name,
          fromStage: previous.stage,
          toStage: parsed.data.stage,
          gateNote: parsed.data.gateNote,
        });
        if (!gate.allowed) {
          return {
            row: null,
            changed: false,
            previousStage: previous.stage,
            blocked: {
              message: blockMessage(parsed.data.stage, gate.failures),
              failures: gate.failures,
              toStage: parsed.data.stage,
            },
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

        // Lost reason: stored when entering 'lost', cleared when leaving it.
        const lostReason =
          parsed.data.stage === 'lost'
            ? parsed.data.reason?.trim()
              ? parsed.data.reason.trim().slice(0, 1000)
              : null
            : null;

        // R2 — hand the reason to the governance trigger, which writes it onto
        // the `deal_audit_log` row for this UPDATE and REJECTS the write if it
        // is missing. Set immediately before the UPDATE and cleared right
        // after, so it can never excuse an unrelated write later in this
        // transaction (same discipline as the close-date note).
        if (rollingBack && parsed.data.rollbackReason) {
          await setStageChangeReason(tx, {
            code: parsed.data.rollbackReason,
            note: parsed.data.rollbackNote,
          });
        }

        const [updated] = await tx
          .update(deals)
          .set({
            stage: parsed.data.stage,
            closedAt: nextClosedAt,
            lostReason,
            // Landing in Lead always means no close date — either it was
            // already null or the user accepted clearing it above.
            ...(parsed.data.stage === 'lead'
              ? { expectedCloseDate: null }
              : {}),
            ...(approvalPatch && {
              approvalStatus: approvalPatch.approvalStatus,
              approvedBy: approvalPatch.approvedBy,
              approvedAt: approvalPatch.approvedAt,
            }),
            // Re-derive the forecast category on stage change — unless a manager
            // has manually overridden it (Module 4).
            ...(previous.forecastCategoryOverridden
              ? {}
              : { forecastCategory: deriveForecastCategory(parsed.data.stage) }),
            // Module 6: set hold fields when entering Hold, clear them otherwise.
            ...(parsed.data.stage === 'hold'
              ? {
                  holdReason: parsed.data.holdReason,
                  holdRevisitOn: parsed.data.holdRevisitOn,
                  holdNote: parsed.data.holdNote?.trim() || null,
                }
              : { holdReason: null, holdRevisitOn: null, holdNote: null }),
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
        // Reset immediately after the write so nothing later in this
        // transaction (or a retry of it) inherits the rollback reason.
        if (rollingBack) await clearStageChangeReason(tx);
        if (!updated) {
          return { row: null, changed: false, previousStage: previous.stage, blocked: null };
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
            ...(lostReason && { reason: lostReason }),
            // R2 — the timeline says "moved backward, because X" rather than
            // just "moved", which is the whole point of capturing it.
            ...(rollingBack && {
              rollback: true,
              rollbackReason: parsed.data.rollbackReason,
              ...(parsed.data.rollbackNote?.trim() && {
                rollbackNote: parsed.data.rollbackNote.trim().slice(0, 1000),
              }),
            }),
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
          blocked: null,
        };
      });

      // R2 — backward move with no reason. The board prompts and retries; a
      // caller that ignores the flag still gets a sensible message.
      if (result.needsRollbackReason) {
        return {
          ok: false,
          message: ROLLBACK_REASON_REQUIRED_MESSAGE,
          needsRollbackReason: true,
          fromStage: result.previousStage ?? undefined,
          toStage: parsed.data.stage,
        };
      }

      // R1 — target stage requires a close date this deal doesn't have.
      if (result.needsCloseDate) {
        return {
          ok: false,
          message: closeDateRequiredMessage(parsed.data.stage),
          needsCloseDate: true,
          toStage: parsed.data.stage,
        };
      }

      // A stage gate rejected the move (nothing was written).
      if (result.blocked) {
        return {
          ok: false,
          message: result.blocked.message,
          blocked: true,
          failures: result.blocked.failures,
          toStage: result.blocked.toStage,
        };
      }

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
        await queueDealScoreRecompute(tenant.id, result.row.id, 'stage_changed');
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

        // R2 — Won → Negotiation is a backward move through the funnel, so the
        // governance trigger demands a reason like any other. The manager has
        // already given one (their rejection); this records it under a system
        // code so the audit trail has no unexplained rollbacks, rather than
        // carving out an exemption that would be a bypass by another name.
        await setStageChangeReason(tx, {
          code: SYSTEM_ROLLBACK_REASONS.approvalRejected,
          note: reason,
        });

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
        await clearStageChangeReason(tx);
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
          // R2, as in the single-deal reject. Set inside the loop and cleared
          // after each write: one transaction covers the whole batch, and a
          // reason left standing would silently authorise the next iteration's
          // rollback — or worse, a later write that isn't one of these.
          await setStageChangeReason(tx, {
            code: SYSTEM_ROLLBACK_REASONS.approvalRejected,
            note: reason,
          });
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
          await clearStageChangeReason(tx);
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
      // The deal's stage at read time, captured for the error messages below —
      // the rejections are thrown from inside the transaction, where the row is
      // in scope, but reported outside it, where it is not.
      let previousStage = '';
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

        previousStage = previous.stage;

        if (
          d.amount !== undefined &&
          (settingsUnitPricing ||
            (previous.unitPriceMinor != null && previous.quantity != null))
        ) {
          throw new Error('AMOUNT_DERIVED');
        }

        // Business rule: setting a close date on a Lead-stage deal is rejected —
        // the deal must first advance to Qualified or higher.
        const effectiveCloseDate =
          d.expectedCloseDate !== undefined
            ? d.expectedCloseDate
            : previous.expectedCloseDate;
        if (violatesLeadCloseDate(previous.stage, effectiveCloseDate)) {
          throw new Error('LEAD_CLOSE_DATE');
        }

        // R3 — THE silent-deletion path this rule exists for. An inline cell
        // edit is exactly how a rep clears a committed date with no trace: the
        // patch action can't change the stage, so there is no rollback here to
        // excuse it. Blanking is refused outright; setting a different date is
        // a pushback (R4) and passes.
        if (
          violatesCloseDateClear({
            nextStage: previous.stage,
            previousCloseDate: previous.expectedCloseDate,
            nextCloseDate: effectiveCloseDate,
          })
        ) {
          throw new Error('CLOSE_DATE_CLEAR');
        }

        // R1 — an inline edit must not leave a deal in a date-required stage
        // with no date. Catches the case the clear-check above misses: a deal
        // that never had one (legacy row, added NOT VALID) being edited now.
        if (violatesMissingCloseDate(previous.stage, effectiveCloseDate)) {
          throw new Error('CLOSE_DATE_REQUIRED');
        }

        // Only the fields present in the input become columns — see
        // lib/deals/patch-columns.ts.
        const patch = buildDealColumnPatch(d, previous, linkPatch);
        if (Object.keys(patch).length === 0) return previous;
        patch.updatedBy = membership.userId;

        // A rep's note about why the date moved. Handed to the pushback trigger
        // via a transaction-local GUC so it lands on the same
        // `deal_date_changes` row the trigger writes for this UPDATE. Only
        // meaningful when the date is actually part of the patch.
        const attachingReason =
          d.expectedCloseDate !== undefined && !!d.closeDateChangeReason?.trim();
        if (attachingReason) {
          await setCloseDateReason(tx, d.closeDateChangeReason);
        }

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
        // Reset immediately after the write so nothing later in this
        // transaction (or a retry of it) inherits the note.
        if (attachingReason) await clearCloseDateReason(tx);
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
        if (err instanceof Error && err.message === 'LEAD_CLOSE_DATE') {
          return { ok: false, message: LEAD_CLOSE_DATE_MESSAGE };
        }
        if (err instanceof Error && err.message === 'CLOSE_DATE_CLEAR') {
          return { ok: false, message: CLOSE_DATE_CLEAR_BLOCKED_MESSAGE };
        }
        // DB backstop (0060) for a legacy row that predates the NOT VALID
        // constraint and so still sits dateless in a date-required stage.
        if (
          (err instanceof Error && err.message === 'CLOSE_DATE_REQUIRED') ||
          isCloseDateRequiredError(err)
        ) {
          return { ok: false, message: closeDateRequiredMessage(previousStage) };
        }
        if (err instanceof UnitPricingIncompleteError) {
          return { ok: false, message: err.message };
        }
        throw err;
      }

      if (!updated) return { ok: false, message: 'Deal not found.' };
      await queueDealScoreRecompute(tenant.id, d.id, 'field_edit');
      revalidatePath('/dashboard/deals');
      revalidatePath('/dashboard/deals/board');
      // The detail page reads these same columns — without this a patch made
      // from that page leaves its sidebar showing the pre-edit values.
      revalidatePath(`/dashboard/deals/${d.id}`);
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
      // Rows without a currency column inherit the workspace default (₹ for
      // this deployment) rather than a hardcoded 'USD' — otherwise a bulk
      // import silently reintroduces the "$0.00" mixed-currency artifact.
      const workspaceCurrency = (await getOrgSettings(tenant.id))
        .defaultCurrency as (typeof KNOWN_CURRENCIES)[number];
      const errors: Array<{ row: number; message: string }> = [];
      const toInsert: typeof deals.$inferInsert[] = [];
      // Parallel to `toInsert`: the source CSV row (1-based) for each candidate,
      // used to report per-row stage-gate rejections below.
      const toInsertRows: number[] = [];

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
        const currency = (currencyRaw || workspaceCurrency) as (typeof KNOWN_CURRENCIES)[number];
        if (!KNOWN_CURRENCIES.includes(currency)) {
          errors.push({
            row: i + 1,
            message: `Unsupported currency "${currencyRaw}".`,
          });
          continue;
        }

        // Margin follows the same rule as the form: mandatory from Qualified
        // onwards, blank in Lead (the rep doesn't know it yet).
        const marginRaw = cell('marginPct');
        let marginBps: number | null = null;
        if (marginRaw) {
          const marginPct = Number(marginRaw.replace(/%$/, '').trim());
          if (!Number.isFinite(marginPct) || marginPct <= 0 || marginPct > 100) {
            errors.push({
              row: i + 1,
              message: `Invalid marginPct "${marginRaw}". Use a number between 0 and 100.`,
            });
            continue;
          }
          marginBps = marginPctToBps(marginPct);
        } else if (marginRequiredForStage(stage)) {
          errors.push({
            row: i + 1,
            message: `Missing "marginPct" — ${MARGIN_REQUIRED_MESSAGE}`,
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

        // Business rule: a dated deal can't be imported at the Lead stage.
        if (violatesLeadCloseDate(stage, expectedCloseDate)) {
          errors.push({ row: i + 1, message: LEAD_CLOSE_DATE_MESSAGE });
          continue;
        }

        // R1 — and the reverse: a row can't be imported into Proposal /
        // Negotiation / Won without a close date. CSV import is the classic
        // way undated deals get into the funnel in bulk, so it is validated
        // with the same rule the form uses rather than a looser one. Reported
        // per row (the partial-success contract) instead of failing the file.
        if (violatesMissingCloseDate(stage, expectedCloseDate)) {
          errors.push({
            row: i + 1,
            message: `Missing "expectedCloseDate" — ${closeDateRequiredMessage(stage)}`,
          });
          continue;
        }

        // Company is a free-text label (matches the deal form) — store as
        // typed; no record lookup or creation.
        const companyNameText = cell('companyName') || null;

        const description = cell('description') || null;
        const isClosedStage = stage === 'won' || stage === 'lost';

        // A row imported at the "lost" stage must carry a reason (matches the
        // interactive flow, where marking a deal Lost always asks why).
        const lostReasonCell = cell('lostReason');
        if (stage === 'lost' && !lostReasonCell) {
          errors.push({
            row: i + 1,
            message: 'Missing "lostReason" — required when stage is "lost".',
          });
          continue;
        }
        const lostReason = stage === 'lost' ? lostReasonCell.slice(0, 1000) : null;

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
          marginBps,
          expectedCloseDate,
          closedAt: isClosedStage ? new Date() : null,
          lostReason,
          ownerId: membership.userId,
        });
        toInsertRows.push(i + 1);
      }

      let inserted = 0;
      if (toInsert.length > 0) {
        const result = await tenantTransaction(async (tx) => {
          // Stage-gate enforcement for the batch. A CSV row importing a deal
          // directly above Lead is a lead→stage transition; rows that fail a
          // block rule are dropped from the insert and reported per-row (the
          // partial-success contract), never silently accepted. `withValues`
          // holds only the survivors so the multi-row INSERT stays one round-trip.
          const withValues: typeof deals.$inferInsert[] = [];
          for (let k = 0; k < toInsert.length; k++) {
            const values = toInsert[k]!;
            const srcRow = toInsertRows[k]!;
            const stage = values.stage as (typeof DEAL_STAGES)[number];
            if (stage && stage !== 'lead') {
              const g = await evaluateStageTransition(tx, {
                tenantId: tenant.id,
                dealId: null,
                fromStage: 'lead',
                toStage: stage,
                override: {
                  companyId: values.companyId ?? null,
                  contactId: values.contactId ?? null,
                  amountMinor: values.amountMinor ?? 0,
                  currency: values.currency ?? 'INR',
                  expectedCloseDate: values.expectedCloseDate ?? null,
                  description: values.description ?? null,
                },
              });
              if (!g.allowed) {
                const blockers = g.failures.filter((f) => f.severity === 'block');
                errors.push({
                  row: srcRow,
                  message: `Stage gate: ${blockers.map((b) => b.message).join('; ')}`,
                });
                continue;
              }
            }
            withValues.push(values);
          }
          if (withValues.length === 0) return 0;
          // OFFERINGS (0066) ARE NOT REQUIRED ON THIS PATH, deliberately.
          // Imported deals land Uncategorized.
          //
          // The mandatory rule is a rule about the create FORM, where a
          // human is present to answer "what is this selling". A CSV has no
          // offering column, so enforcing it here would reject every file
          // the team already uses — turning an import into a data-entry
          // session, which is the opposite of why anyone imports.
          //
          // The gap is not silent: imported rows are Uncategorized like any
          // legacy deal, so they surface in the deals list's Uncategorized
          // filter and in the funnel report's coverage total, and get tagged
          // through the same one-at-a-time flow. If bulk tagging on import
          // is ever wanted, the shape is an optional `Offering` column
          // resolved by name — additive to BULK_UPLOAD_HEADERS, so old
          // files keep working.
          //
          // Single multi-row INSERT — fast, atomic, and we don't
          // bother emitting realtime events per row to avoid a
          // notification storm. The list/board pages revalidate
          // below and rehydrate from the DB instead.
          const inserted = await tx
            .insert(deals)
            .values(withValues)
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
