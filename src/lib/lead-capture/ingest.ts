import 'server-only';

import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { contacts, deals, leadIngestEvents, leadSources } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { logger } from '@/lib/observability';

import { applyFieldMapping, leadDisplayName, validateMappedLead, type MappedLead } from './mapping';
import { ingestIdempotencyKey } from './signature';

/**
 * Lead ingest.
 *
 *  1. `receiveIngestEvent` (public route, sync): persist the raw payload FIRST
 *     and return its id. A replay of the same payload from the same source
 *     within 24h returns the original event id instead of storing a second
 *     one, so webhook retries are safe (at-least-once delivery).
 *  2. `processIngestEvent` (Inngest, async): map → normalize → validate →
 *     dedupe → create or re-enquire. Idempotent: an event that is already
 *     processed/duplicate is a no-op.
 */

const REPLAY_WINDOW_HOURS = 24;
/** A closed-lost lead older than this is reopened on a re-enquiry. */
const REOPEN_LOST_AFTER_DAYS = 30;

export type SourceLookup = {
  tenantId: string;
  secretToken: string;
  isActive: boolean;
  allowedOrigins: string[];
};

/**
 * Resolve a source by id before any tenant context exists, via the narrow
 * SECURITY DEFINER function from 0072. Returns null for an unknown id.
 */
export async function lookupSourceForPublic(sourceId: string): Promise<SourceLookup | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return null;
  const rows = await db.execute<{
    tenant_id: string;
    secret_token: string;
    is_active: boolean;
    allowed_origins: string[] | null;
  }>(sql`select * from lead_source_public_lookup(${sourceId}::uuid)`);
  const r = rows[0];
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    secretToken: r.secret_token,
    isActive: r.is_active,
    allowedOrigins: r.allowed_origins ?? [],
  };
}

export async function receiveIngestEvent(args: {
  tenantId: string;
  sourceId: string;
  payload: unknown;
}): Promise<{ eventId: string; replay: boolean }> {
  const { tenantId, sourceId, payload } = args;
  const key = ingestIdempotencyKey(sourceId, payload);
  return await runWithSystemContext(tenantId, () =>
    tenantTransaction(async (tx) => {
      // Serialize concurrent deliveries of the same payload.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ingest:${sourceId}:${key}`}, 0))`);
      const [existing] = await tx
        .select({ id: leadIngestEvents.id })
        .from(leadIngestEvents)
        .where(
          and(
            eq(leadIngestEvents.sourceId, sourceId),
            eq(leadIngestEvents.idempotencyKey, key),
            gt(leadIngestEvents.receivedAt, sql`now() - make_interval(hours => ${REPLAY_WINDOW_HOURS})`),
          ),
        )
        .orderBy(desc(leadIngestEvents.receivedAt))
        .limit(1);
      if (existing) return { eventId: existing.id, replay: true };
      const [row] = await tx
        .insert(leadIngestEvents)
        .values({ tenantId, sourceId, rawPayload: payload as object, idempotencyKey: key })
        .returning({ id: leadIngestEvents.id });
      return { eventId: row!.id, replay: false };
    }),
  );
}

export type ProcessOutcome =
  | { status: 'created'; eventId: string; dealId: string; contactId: string }
  | { status: 'duplicate'; eventId: string; dealId: string; reopened: boolean; ownerId: string | null }
  | { status: 'failed'; eventId: string; error: string }
  | { status: 'noop'; eventId: string; reason: string };

/** Must run inside runWithSystemContext(tenantId). */
export async function processIngestEvent(eventId: string): Promise<ProcessOutcome> {
  return await tenantTransaction(async (tx) => {
    const [ev] = await tx
      .select({
        id: leadIngestEvents.id,
        tenantId: leadIngestEvents.tenantId,
        sourceId: leadIngestEvents.sourceId,
        status: leadIngestEvents.status,
        rawPayload: leadIngestEvents.rawPayload,
        sourceName: leadSources.name,
        sourceType: leadSources.type,
        fieldMapping: leadSources.fieldMapping,
        sourceActive: leadSources.isActive,
      })
      .from(leadIngestEvents)
      .innerJoin(leadSources, eq(leadSources.id, leadIngestEvents.sourceId))
      .where(eq(leadIngestEvents.id, eventId))
      .for('update', { of: leadIngestEvents });
    if (!ev) return { status: 'noop', eventId, reason: 'event not found' };
    if (ev.status === 'processed' || ev.status === 'duplicate') {
      return { status: 'noop', eventId, reason: `already ${ev.status}` };
    }

    const fail = async (error: string): Promise<ProcessOutcome> => {
      await tx
        .update(leadIngestEvents)
        .set({ status: 'failed', error, processedAt: new Date(), attempts: sql`${leadIngestEvents.attempts} + 1` })
        .where(eq(leadIngestEvents.id, eventId));
      return { status: 'failed', eventId, error };
    };

    const lead = applyFieldMapping(ev.rawPayload, ev.fieldMapping ?? {});
    const invalid = validateMappedLead(lead);
    if (invalid) return await fail(invalid);

    // Serialize leads for the same person across sources/workers so two
    // simultaneous enquiries can't both miss the dedupe and create two leads.
    for (const k of [lead.phoneNormalized, lead.emailNormalized].filter(Boolean).sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`lead:${ev.tenantId}:${k}`}, 0))`);
    }

    const match = await findExistingLead(tx, ev.tenantId, lead);
    const now = new Date();
    const utmLine = [lead.utm.source, lead.utm.medium, lead.utm.campaign].filter(Boolean).join(' / ');

    if (match?.dealId) {
      const reopen =
        match.stage === 'lost' &&
        match.closedAt !== null &&
        now.getTime() - match.closedAt.getTime() > REOPEN_LOST_AFTER_DAYS * 86_400_000;
      await tx
        .update(deals)
        .set({
          lastEnquiryAt: now,
          ...(reopen ? { stage: 'lead' as const, closedAt: null, lostReason: null, routingStatus: match.ownerId ? 'assigned' : 'pending' } : {}),
          updatedBy: 'system',
        })
        .where(eq(deals.id, match.dealId));
      await recordActivity(tx, {
        tenantId: ev.tenantId,
        actorUserId: null,
        entityType: 'deal',
        entityId: match.dealId,
        action: 'automation_note',
        metadata: {
          name: match.dealName,
          kind: 'lead_reenquiry',
          message:
            `Re-enquiry via ${ev.sourceName}${utmLine ? ` (${utmLine})` : ''}` +
            (lead.productInterest ? ` — ${lead.productInterest}` : '') +
            (reopen ? '. Reopened from Lost.' : ''),
          sourceId: ev.sourceId,
          ingestEventId: eventId,
          utm: lead.utm,
        },
      });
      await tx
        .update(leadIngestEvents)
        .set({ status: 'duplicate', dealId: match.dealId, processedAt: now, error: null, attempts: sql`${leadIngestEvents.attempts} + 1` })
        .where(eq(leadIngestEvents.id, eventId));
      return { status: 'duplicate', eventId, dealId: match.dealId, reopened: reopen, ownerId: match.ownerId };
    }

    // New lead. Reuse the contact if we know the person but they have no lead deal.
    let contactId = match?.contactId ?? null;
    if (!contactId) {
      const [c] = await tx
        .insert(contacts)
        .values({
          tenantId: ev.tenantId,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
          title: lead.title,
          emailNormalized: lead.emailNormalized,
          phoneNormalized: lead.phoneNormalized,
          normalizedName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').toLowerCase() || null,
          updatedBy: 'system',
        })
        .returning({ id: contacts.id });
      contactId = c!.id;
    }

    const name = leadDisplayName(lead);
    const [deal] = await tx
      .insert(deals)
      .values({
        tenantId: ev.tenantId,
        contactId,
        name,
        description: lead.message,
        companyNameText: lead.company,
        contactNameText: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
        contactEmailText: lead.emailNormalized,
        customFields: lead.custom,
        stage: 'lead',
        currency: 'INR',
        source: ev.sourceName,
        leadSourceId: ev.sourceId,
        utmSource: lead.utm.source,
        utmMedium: lead.utm.medium,
        utmCampaign: lead.utm.campaign,
        utmTerm: lead.utm.term,
        utmContent: lead.utm.content,
        landingUrl: lead.landingUrl,
        referrerUrl: lead.referrerUrl,
        consentGiven: lead.consent,
        consentAt: lead.consent ? now : null,
        lastEnquiryAt: now,
        leadCity: lead.city,
        leadState: lead.state,
        leadProductInterest: lead.productInterest,
        routingStatus: 'pending',
        routingQueuedAt: now,
        updatedBy: 'system',
      })
      .returning({ id: deals.id });

    await recordActivity(tx, {
      tenantId: ev.tenantId,
      actorUserId: null,
      entityType: 'deal',
      entityId: deal!.id,
      action: 'automation_note',
      metadata: {
        name,
        kind: 'lead_captured',
        message: `Lead captured via ${ev.sourceName}${utmLine ? ` (${utmLine})` : ''}`,
        sourceId: ev.sourceId,
        ingestEventId: eventId,
      },
    });
    await tx
      .update(leadIngestEvents)
      .set({ status: 'processed', dealId: deal!.id, processedAt: now, error: null, attempts: sql`${leadIngestEvents.attempts} + 1` })
      .where(eq(leadIngestEvents.id, eventId));

    logger.info('lead created from ingest', { tenantId: ev.tenantId, eventId, dealId: deal!.id });
    return { status: 'created', eventId, dealId: deal!.id, contactId };
  });
}

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Dedupe: a non-deleted, non-merged contact with the same normalized phone OR
 * email. Returns its most recent lead deal (any stage, not deleted), if any.
 */
async function findExistingLead(
  tx: DrizzleTx,
  tenantId: string,
  lead: MappedLead,
): Promise<{
  contactId: string;
  dealId: string | null;
  dealName: string | null;
  stage: string | null;
  closedAt: Date | null;
  ownerId: string | null;
} | null> {
  const keys = [];
  if (lead.phoneNormalized) keys.push(eq(contacts.phoneNormalized, lead.phoneNormalized));
  if (lead.emailNormalized) keys.push(eq(contacts.emailNormalized, lead.emailNormalized));
  if (keys.length === 0) return null;

  const rows = await tx
    .select({
      contactId: contacts.id,
      dealId: deals.id,
      dealName: deals.name,
      stage: deals.stage,
      closedAt: deals.closedAt,
      ownerId: deals.ownerId,
    })
    .from(contacts)
    .leftJoin(deals, and(eq(deals.contactId, contacts.id), isNull(deals.deletedAt)))
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        isNull(contacts.deletedAt),
        isNull(contacts.mergedIntoId),
        or(...keys),
      ),
    )
    // Prefer a contact that has a deal; then the newest deal.
    .orderBy(sql`${deals.id} is null`, desc(deals.createdAt), desc(contacts.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    contactId: r.contactId,
    dealId: r.dealId,
    dealName: r.dealName,
    stage: r.stage,
    closedAt: r.closedAt,
    ownerId: r.ownerId,
  };
}

/** Manual retry from the failed-events list: back to 'received', then re-process. */
export async function resetIngestEventForRetry(eventId: string): Promise<boolean> {
  const rows = await tenantTransaction((tx) =>
    tx
      .update(leadIngestEvents)
      .set({ status: 'received', error: null })
      .where(and(eq(leadIngestEvents.id, eventId), eq(leadIngestEvents.status, 'failed')))
      .returning({ id: leadIngestEvents.id }),
  );
  return rows.length > 0;
}
