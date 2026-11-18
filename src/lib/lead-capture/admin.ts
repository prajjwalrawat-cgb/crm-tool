import 'server-only';

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  captureForms,
  contacts,
  deals,
  distributionRules,
  leadAssignments,
  leadImportJobs,
  leadIngestEvents,
  leadSources,
  userRoutingProfile,
  type IngestStatus,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { generateSourceSecret } from './signature';
import type {
  CaptureFormInput,
  DistributionRuleInput,
  LeadSourceInput,
  RoutingProfileInput,
} from './validation';

/**
 * Lead-capture admin queries + mutations (Settings screens, unassigned queue,
 * assignment history). Every function runs inside the caller's tenant
 * context and filters on tenant_id explicitly as well as through RLS.
 */

/* ------------------------------------------------------------------ sources */

export type LeadSourceListItem = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  defaultRuleId: string | null;
  allowedOrigins: string[];
  createdAt: Date;
  lastEventAt: Date | null;
  events7d: number;
  failed7d: number;
};

export async function listLeadSources(tenantId: string): Promise<LeadSourceListItem[]> {
  return await tenantTransaction(async (tx) => {
    const rows = await tx
      .select({
        id: leadSources.id,
        name: leadSources.name,
        type: leadSources.type,
        isActive: leadSources.isActive,
        defaultRuleId: leadSources.defaultRuleId,
        allowedOrigins: leadSources.allowedOrigins,
        createdAt: leadSources.createdAt,
        lastEventAt: sql<Date | null>`(select max(e.received_at) from lead_ingest_events e where e.source_id = ${leadSources.id})`,
        events7d: sql<number>`(select count(*)::int from lead_ingest_events e where e.source_id = ${leadSources.id} and e.received_at > now() - interval '7 days')`,
        failed7d: sql<number>`(select count(*)::int from lead_ingest_events e where e.source_id = ${leadSources.id} and e.status = 'failed' and e.received_at > now() - interval '7 days')`,
      })
      .from(leadSources)
      .where(eq(leadSources.tenantId, tenantId))
      .orderBy(asc(leadSources.name));
    return rows.map((r) => ({
      ...r,
      lastEventAt: r.lastEventAt ? new Date(r.lastEventAt) : null,
      events7d: Number(r.events7d),
      failed7d: Number(r.failed7d),
    }));
  });
}

export async function getLeadSource(tenantId: string, id: string) {
  const [row] = await tenantTransaction((tx) =>
    tx.select().from(leadSources).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id))),
  );
  return row ?? null;
}

export async function createLeadSource(tenantId: string, createdBy: string, input: LeadSourceInput) {
  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(leadSources)
      .values({
        tenantId,
        name: input.name,
        type: input.type,
        secretToken: generateSourceSecret(),
        fieldMapping: input.fieldMapping,
        defaultRuleId: input.defaultRuleId,
        allowedOrigins: input.allowedOrigins,
        config: input.config,
        createdBy,
      })
      .returning({ id: leadSources.id }),
  );
  return row!.id;
}

export async function updateLeadSource(tenantId: string, id: string, input: LeadSourceInput): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(leadSources)
      .set({
        name: input.name,
        type: input.type,
        fieldMapping: input.fieldMapping,
        defaultRuleId: input.defaultRuleId,
        allowedOrigins: input.allowedOrigins,
        config: input.config,
      })
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id)))
      .returning({ id: leadSources.id }),
  );
  return rows.length > 0;
}

export async function rotateLeadSourceSecret(tenantId: string, id: string): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(leadSources)
      .set({ secretToken: generateSourceSecret() })
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id)))
      .returning({ id: leadSources.id }),
  );
  return rows.length > 0;
}

export async function setLeadSourceActive(tenantId: string, id: string, isActive: boolean): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(leadSources)
      .set({ isActive })
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id)))
      .returning({ id: leadSources.id }),
  );
  return rows.length > 0;
}

export type IngestEventListItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  status: IngestStatus;
  error: string | null;
  dealId: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  attempts: number;
  preview: string;
};

/** Recent ingest events. `preview` is a short, non-sensitive summary of field names only. */
export async function listIngestEvents(
  tenantId: string,
  opts: { sourceId?: string; status?: IngestStatus; limit?: number } = {},
): Promise<IngestEventListItem[]> {
  const where = [eq(leadIngestEvents.tenantId, tenantId)];
  if (opts.sourceId) where.push(eq(leadIngestEvents.sourceId, opts.sourceId));
  if (opts.status) where.push(eq(leadIngestEvents.status, opts.status));
  const rows = await tenantTransaction((tx) =>
    tx
      .select({
        id: leadIngestEvents.id,
        sourceId: leadIngestEvents.sourceId,
        sourceName: leadSources.name,
        status: leadIngestEvents.status,
        error: leadIngestEvents.error,
        dealId: leadIngestEvents.dealId,
        receivedAt: leadIngestEvents.receivedAt,
        processedAt: leadIngestEvents.processedAt,
        attempts: leadIngestEvents.attempts,
        raw: leadIngestEvents.rawPayload,
      })
      .from(leadIngestEvents)
      .innerJoin(leadSources, eq(leadSources.id, leadIngestEvents.sourceId))
      .where(and(...where))
      .orderBy(desc(leadIngestEvents.receivedAt))
      .limit(Math.min(opts.limit ?? 50, 200)),
  );
  return rows.map(({ raw, ...r }) => ({
    ...r,
    preview:
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.keys(raw as Record<string, unknown>).slice(0, 8).join(', ')
        : '',
  }));
}

/* ------------------------------------------------------------------ rules */

export async function listDistributionRules(tenantId: string) {
  return await tenantTransaction((tx) =>
    tx
      .select()
      .from(distributionRules)
      .where(eq(distributionRules.tenantId, tenantId))
      .orderBy(asc(distributionRules.priority), asc(distributionRules.createdAt)),
  );
}

export async function createDistributionRule(tenantId: string, input: DistributionRuleInput): Promise<string> {
  return await tenantTransaction(async (tx) => {
    const [{ maxPriority } = { maxPriority: 0 }] = await tx
      .select({ maxPriority: sql<number>`coalesce(max(${distributionRules.priority}), 0)::int` })
      .from(distributionRules)
      .where(eq(distributionRules.tenantId, tenantId));
    if (input.isDefault) {
      await tx.update(distributionRules).set({ isDefault: false }).where(eq(distributionRules.tenantId, tenantId));
    }
    const [row] = await tx
      .insert(distributionRules)
      .values({ tenantId, ...input, priority: Number(maxPriority) + 10 })
      .returning({ id: distributionRules.id });
    return row!.id;
  });
}

export async function updateDistributionRule(tenantId: string, id: string, input: DistributionRuleInput): Promise<boolean> {
  return await tenantTransaction(async (tx) => {
    if (input.isDefault) {
      await tx
        .update(distributionRules)
        .set({ isDefault: false })
        .where(and(eq(distributionRules.tenantId, tenantId), sql`${distributionRules.id} <> ${id}`));
    }
    const rows = await tx
      .update(distributionRules)
      .set({ ...input })
      .where(and(eq(distributionRules.tenantId, tenantId), eq(distributionRules.id, id)))
      .returning({ id: distributionRules.id });
    return rows.length > 0;
  });
}

export async function deleteDistributionRule(tenantId: string, id: string): Promise<boolean> {
  return await tenantTransaction(async (tx) => {
    await tx
      .update(leadSources)
      .set({ defaultRuleId: null })
      .where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.defaultRuleId, id)));
    const rows = await tx
      .delete(distributionRules)
      .where(and(eq(distributionRules.tenantId, tenantId), eq(distributionRules.id, id)))
      .returning({ id: distributionRules.id });
    return rows.length > 0;
  });
}

/** Rewrite priorities from the given order (10, 20, 30 …). Unknown ids are ignored. */
export async function reorderDistributionRules(tenantId: string, orderedIds: string[]): Promise<void> {
  await tenantTransaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) {
      await tx
        .update(distributionRules)
        .set({ priority: (i + 1) * 10 })
        .where(and(eq(distributionRules.tenantId, tenantId), eq(distributionRules.id, id)));
    }
  });
}

/* ------------------------------------------------------------------ routing profiles */

export async function listRoutingProfiles(tenantId: string) {
  return await tenantTransaction((tx) =>
    tx.select().from(userRoutingProfile).where(eq(userRoutingProfile.tenantId, tenantId)),
  );
}

export async function upsertRoutingProfile(tenantId: string, input: RoutingProfileInput): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .insert(userRoutingProfile)
      .values({ tenantId, ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [userRoutingProfile.tenantId, userRoutingProfile.userId],
        set: {
          isAvailable: input.isAvailable,
          workingHours: input.workingHours,
          skills: input.skills,
          regions: input.regions,
          updatedAt: new Date(),
        },
      }),
  );
}

/** Availability toggle only (also driven by the telephony softphone bar). */
export async function setUserAvailability(tenantId: string, userId: string, isAvailable: boolean): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .insert(userRoutingProfile)
      .values({ tenantId, userId, isAvailable, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [userRoutingProfile.tenantId, userRoutingProfile.userId],
        set: { isAvailable, updatedAt: new Date() },
      }),
  );
}

/* ------------------------------------------------------------------ forms */

export async function listCaptureForms(tenantId: string) {
  return await tenantTransaction((tx) =>
    tx
      .select({
        id: captureForms.id,
        slug: captureForms.slug,
        title: captureForms.title,
        isPublished: captureForms.isPublished,
        sourceId: captureForms.sourceId,
        sourceName: leadSources.name,
        fieldCount: sql<number>`jsonb_array_length(${captureForms.fields})::int`,
        updatedAt: captureForms.updatedAt,
      })
      .from(captureForms)
      .innerJoin(leadSources, eq(leadSources.id, captureForms.sourceId))
      .where(eq(captureForms.tenantId, tenantId))
      .orderBy(desc(captureForms.updatedAt)),
  );
}

export async function getCaptureForm(tenantId: string, id: string) {
  const [row] = await tenantTransaction((tx) =>
    tx.select().from(captureForms).where(and(eq(captureForms.tenantId, tenantId), eq(captureForms.id, id))),
  );
  return row ?? null;
}

export class DuplicateFormSlugError extends Error {}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export async function createCaptureForm(tenantId: string, input: CaptureFormInput): Promise<string> {
  try {
    const [row] = await tenantTransaction((tx) =>
      tx.insert(captureForms).values({ tenantId, ...input }).returning({ id: captureForms.id }),
    );
    return row!.id;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateFormSlugError('A form with that slug already exists');
    throw err;
  }
}

export async function updateCaptureForm(tenantId: string, id: string, input: CaptureFormInput): Promise<boolean> {
  try {
    const rows = await tenantTransaction((tx) =>
      tx
        .update(captureForms)
        .set({ ...input })
        .where(and(eq(captureForms.tenantId, tenantId), eq(captureForms.id, id)))
        .returning({ id: captureForms.id }),
    );
    return rows.length > 0;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateFormSlugError('A form with that slug already exists');
    throw err;
  }
}

export async function setCaptureFormPublished(tenantId: string, id: string, isPublished: boolean): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(captureForms)
      .set({ isPublished })
      .where(and(eq(captureForms.tenantId, tenantId), eq(captureForms.id, id)))
      .returning({ id: captureForms.id }),
  );
  return rows.length > 0;
}

export async function deleteCaptureForm(tenantId: string, id: string): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .delete(captureForms)
      .where(and(eq(captureForms.tenantId, tenantId), eq(captureForms.id, id)))
      .returning({ id: captureForms.id }),
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ unassigned queue */

export type UnassignedFilter = { sourceId?: string; q?: string; state?: string };

function unassignedWhere(tenantId: string, f: UnassignedFilter) {
  const where = [
    eq(deals.tenantId, tenantId),
    inArray(deals.routingStatus, ['unassigned', 'pending']),
    eq(deals.stage, 'lead'),
    isNull(deals.deletedAt),
  ];
  if (f.sourceId) where.push(eq(deals.leadSourceId, f.sourceId));
  if (f.state) where.push(sql`lower(${deals.leadState}) = lower(${f.state})`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${deals.name} ilike ${like} or ${deals.companyNameText} ilike ${like} or ${deals.leadCity} ilike ${like})`);
  }
  return and(...where);
}

export async function listUnassignedLeads(tenantId: string, f: UnassignedFilter = {}, limit = 200) {
  return await tenantTransaction((tx) =>
    tx
      .select({
        id: deals.id,
        name: deals.name,
        company: deals.companyNameText,
        city: deals.leadCity,
        state: deals.leadState,
        productInterest: deals.leadProductInterest,
        sourceName: leadSources.name,
        queuedAt: deals.routingQueuedAt,
        createdAt: deals.createdAt,
        phone: contacts.phone,
        email: contacts.email,
      })
      .from(deals)
      .leftJoin(leadSources, eq(leadSources.id, deals.leadSourceId))
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .where(unassignedWhere(tenantId, f))
      .orderBy(asc(deals.routingQueuedAt), asc(deals.createdAt))
      .limit(limit),
  );
}

/** Ids of every lead matching a filter ("select all matching", not just the visible page). */
export async function listUnassignedLeadIds(tenantId: string, f: UnassignedFilter = {}): Promise<string[]> {
  const rows = await tenantTransaction((tx) =>
    tx.select({ id: deals.id }).from(deals).where(unassignedWhere(tenantId, f)).limit(5000),
  );
  return rows.map((r) => r.id);
}

export async function countUnassignedLeads(tenantId: string): Promise<number> {
  const [r] = await tenantTransaction((tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(deals).where(unassignedWhere(tenantId, {})),
  );
  return Number(r?.n ?? 0);
}

/* ------------------------------------------------------------------ assignment history */

export async function getAssignmentHistory(tenantId: string, dealId: string) {
  return await tenantTransaction((tx) =>
    tx
      .select({
        id: leadAssignments.id,
        assignedTo: leadAssignments.assignedTo,
        assignedBy: leadAssignments.assignedBy,
        ruleName: distributionRules.name,
        reason: leadAssignments.reason,
        assignedAt: leadAssignments.assignedAt,
        firstTouchAt: leadAssignments.firstTouchAt,
        slaDueAt: leadAssignments.slaDueAt,
        releasedAt: leadAssignments.releasedAt,
        releaseReason: leadAssignments.releaseReason,
        escalatedAt: leadAssignments.escalatedAt,
        slaPassed: sql<boolean>`${leadAssignments.slaDueAt} < now()`,
      })
      .from(leadAssignments)
      .leftJoin(distributionRules, eq(distributionRules.id, leadAssignments.ruleId))
      .where(and(eq(leadAssignments.tenantId, tenantId), eq(leadAssignments.dealId, dealId)))
      .orderBy(desc(leadAssignments.assignedAt)),
  );
}

/** Lead-capture fields on a deal (source, UTM, consent) for the deal page. */
export async function getDealCaptureInfo(tenantId: string, dealId: string) {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({
        sourceName: leadSources.name,
        sourceType: leadSources.type,
        utmSource: deals.utmSource,
        utmMedium: deals.utmMedium,
        utmCampaign: deals.utmCampaign,
        landingUrl: deals.landingUrl,
        consentGiven: deals.consentGiven,
        lastEnquiryAt: deals.lastEnquiryAt,
        routingStatus: deals.routingStatus,
      })
      .from(deals)
      .leftJoin(leadSources, eq(leadSources.id, deals.leadSourceId))
      .where(and(eq(deals.tenantId, tenantId), eq(deals.id, dealId))),
  );
  return row ?? null;
}

/* ------------------------------------------------------------------ import jobs */

export async function getImportJob(tenantId: string, id: string) {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select({
        id: leadImportJobs.id,
        status: leadImportJobs.status,
        fileName: leadImportJobs.fileName,
        total: leadImportJobs.total,
        processed: leadImportJobs.processed,
        createdCount: leadImportJobs.createdCount,
        duplicateCount: leadImportJobs.duplicateCount,
        failedCount: leadImportJobs.failedCount,
        errors: leadImportJobs.errors,
        createdAt: leadImportJobs.createdAt,
        finishedAt: leadImportJobs.finishedAt,
      })
      .from(leadImportJobs)
      .where(and(eq(leadImportJobs.tenantId, tenantId), eq(leadImportJobs.id, id))),
  );
  return row ?? null;
}
