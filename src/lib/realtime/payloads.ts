import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import {
  type ActivityAction,
  type ActivityEntityType,
  type ActivityLog,
  type Company,
  companies,
  type Contact,
  contacts,
  deals,
  dealRiskScores,} from '@/db/schema';


import {
  type SerializedActivity,
  type SerializedCompany,
  type SerializedContact,
  type SerializedDeal,
  serializeDates,
} from './events';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function serializeCompany(row: Company): SerializedCompany {
  return serializeDates(row);
}

export function serializeContact(row: Contact): SerializedContact {
  return serializeDates(row);
}

/**
 * Realtime activity payload — bare row, no actor hydration. Clients render
 * with a "Someone" fallback until they refresh and re-fetch through
 * `listRecentActivity`, which does the Clerk batch lookup.
 */
export function serializeActivity(row: ActivityLog): SerializedActivity {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actorUserId: row.actorUserId,
    entityType: row.entityType as ActivityEntityType,
    entityId: row.entityId,
    action: row.action as ActivityAction,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    actor: null,
  };
}

/**
 * Re-fetch the inserted/updated/deleted deal joined with company + contact
 * names so realtime subscribers receive a board-ready row, not a bare Deal.
 * Runs inside the caller's transaction, so the GUCs are inherited and the
 * row is the one we just wrote (read-your-own-writes within the tx).
 *
 * Note: we do NOT filter out soft-deleted rows — `deal.deleted` event needs
 * the full row of the just-deleted entity.
 */
export async function loadSerializedDeal(
  tx: DrizzleTx,
  tenantId: string,
  id: string,
): Promise<SerializedDeal | null> {
  const rows = await tx
    .select({
      id: deals.id,
      tenantId: deals.tenantId,
      companyId: deals.companyId,
      contactId: deals.contactId,
      name: deals.name,
      description: deals.description,
      stage: deals.stage,
      dealType: deals.dealType,
      amountMinor: deals.amountMinor,
      unitPriceMinor: deals.unitPriceMinor,
      quantity: deals.quantity,
      offerPriceMinor: deals.offerPriceMinor,
      marginBps: deals.marginBps,
      approvalStatus: deals.approvalStatus,
      approvedBy: deals.approvedBy,
      approvedAt: deals.approvedAt,
      lostReason: deals.lostReason,
      nextStep: deals.nextStep,
      competitor: deals.competitor,
      source: deals.source,
      currency: deals.currency,
      expectedCloseDate: deals.expectedCloseDate,
      // Pushback cache (0058) — without these the board's realtime reconcile
      // would drop a card's slip chip until the next full page load.
      originalCloseDate: deals.originalCloseDate,
      pushCount: deals.pushCount,
      lastPushedAt: deals.lastPushedAt,
      totalSlipDays: deals.totalSlipDays,
      // Governance cache (0060) — same reasoning: without these a realtime
      // reconcile would drop a card's rollback badge until the next reload.
      rollbackCount: deals.rollbackCount,
      quotaWeight: deals.quotaWeight,
      lastStageChangedAt: deals.lastStageChangedAt,
      closedAt: deals.closedAt,
      ownerId: deals.ownerId,
      probability: deals.probability,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
      deletedAt: deals.deletedAt,
      deletedBy: deals.deletedBy,
      companyNameText: deals.companyNameText,
      contactNameText: deals.contactNameText,
      contactEmailText: deals.contactEmailText,
      customFields: deals.customFields,
      updatedBy: deals.updatedBy,
      healthScore: deals.healthScore,
      healthBand: deals.healthBand,
      riskScore: dealRiskScores.score,
      riskBand: dealRiskScores.band,
      forecastCategory: deals.forecastCategory,
      forecastCategoryOverridden: deals.forecastCategoryOverridden,
      holdReason: deals.holdReason,
      holdRevisitOn: deals.holdRevisitOn,
      holdNote: deals.holdNote,
      companyName: companies.name,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
    })
    .from(deals)
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(dealRiskScores, eq(dealRiskScores.dealId, deals.id))
    .where(and(eq(deals.tenantId, tenantId), eq(deals.id, id)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const { contactFirstName, contactLastName, contactEmail, ...rest } = row;
  const nameParts = [contactFirstName, contactLastName].filter(Boolean) as string[];
  const reshaped = {
    ...rest,
    companyName: rest.companyNameText ?? rest.companyName,
    contactName:
      rest.contactNameText ?? (nameParts.length ? nameParts.join(' ') : null),
    contactEmail: rest.contactEmailText ?? contactEmail,
  };
  return serializeDates(reshaped);
}
