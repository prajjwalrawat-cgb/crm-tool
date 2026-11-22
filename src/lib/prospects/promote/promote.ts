import 'server-only';

import { and, asc, eq, isNull, ne } from 'drizzle-orm';

import { comments, companies, contacts, deals, leadAssignments, memberships, notes, offerings, prospects, users, type Prospect } from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { tenantTransaction } from '@/lib/db-context';
import { normalizeCompanyName, normalizeContactName } from '@/lib/dedup/normalize';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { distributeLead, listLeadManagers, type DistributeOutcome } from '@/lib/lead-capture/distribute';
import { notifyAssigned, reassignLead } from '@/lib/lead-capture/sla';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { captureError, logger } from '@/lib/observability';
import { can } from '@/lib/rbac';
import { loadSerializedDeal, serializeCompany, serializeContact } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { scopeUsers, type ReportScope } from '@/lib/reports/manager/scope';

import { MESSAGES, UUID_RE } from '../mutations';
import { isClaimActive, type Actor } from '../rules';
import { ensureProspectBoardSource } from './lead-source';
import { findPromoteCandidates } from './match';
import { promoteBlock, type MatchCandidate, type PromoteBlock } from './rules';

/**
 * Promote a prospect to a lead: create one (company + contact + deal) or link
 * an existing open lead, all in one transaction that holds the prospect row
 * FOR UPDATE. Routing (claimer, else distribution rules) runs after commit;
 * a routing failure never undoes the promotion.
 */

export type PromoteChoice = {
  leadId?: string;
  companyId?: string;
  contactId?: string;
  createAnyway?: boolean;
  ignoreWarnings?: boolean;
};

/** 'none': a linked lead keeps its owner, nothing is routed. */
export type PromoteRouting = 'claimer' | 'distributed' | 'unassigned' | 'queued' | 'retry' | 'none';

export type PromoteOutcome =
  | { status: 'promoted'; dealId: string; linked: boolean; routing: PromoteRouting }
  | { status: 'blocked'; candidates: MatchCandidate[] }
  | { status: 'warn'; candidates: MatchCandidate[] }
  | { status: 'error'; error: string; message: string };

export type PromoteDeps = {
  distribute?: typeof distributeLead;
  reassign?: typeof reassignLead;
  sendEvent?: typeof sendWorkflowEvent;
};

export const MAX_BULK_PROMOTE = 100;

export const PROMOTE_MESSAGES = {
  not_found: MESSAGES.not_found,
  promoted: MESSAGES.promoted,
  deleted: MESSAGES.deleted,
  no_permission: MESSAGES.no_permission,
  out_of_scope: MESSAGES.out_of_scope,
  claimed_by_other: 'Claimed by someone else. Only they or a manager can promote it.',
  parked: 'Unpark it first.',
  missing_contact: 'Add an email or phone before promoting.',
  invalid: 'That record is no longer a match. Refresh and pick again.',
  both: 'Pick an open lead, or a company and contact, not both.',
  lead_taken: 'That lead is already linked to another prospect.',
  contact_company: 'That contact belongs to a different company.',
  too_many: `Promote at most ${MAX_BULK_PROMOTE} prospects at a time.`,
  error: 'Something went wrong. Try again.',
} as const;

type ErrorCode = PromoteBlock | 'not_found' | 'invalid' | 'error';

const fail = (error: ErrorCode, message: string = PROMOTE_MESSAGES[error]): PromoteOutcome => ({ status: 'error', error, message });

/** Create anyway: managers and owner/admin only. */
const canCreateAnyway = (role: Actor['role']) =>
  can(role, 'manageProspectClaims') || (can(role, 'manageDeals') && role !== 'member');

type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];

const commentDate = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

/** Prospect notes as one note, then each comment (oldest first) with its author and date. */
async function noteBodies(tx: Tx, tenantId: string, p: Prospect): Promise<string[]> {
  const rows = await tx
    .select({ body: comments.body, createdAt: comments.createdAt, first: users.firstName, last: users.lastName, email: users.email })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorUserId))
    .where(and(eq(comments.tenantId, tenantId), eq(comments.entityType, 'prospect'), eq(comments.entityId, p.id), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const out: string[] = [];
  if (p.notes?.trim()) out.push(p.notes);
  for (const c of rows) {
    const name = [c.first, c.last].filter(Boolean).join(' ').trim() || c.email || 'a former user';
    out.push(`Comment by ${name} on ${commentDate.format(c.createdAt)}:\n${c.body}`);
  }
  return out;
}

async function insertNotes(tx: Tx, tenantId: string, actor: Actor, dealId: string, bodies: string[], now: Date) {
  if (bodies.length === 0) return;
  // Distinct timestamps keep the copied order on the deal timeline.
  await tx.insert(notes).values(
    bodies.map((body, i) => ({
      tenantId,
      body,
      authorUserId: actor.userId,
      entityType: 'deal',
      entityId: dealId,
      createdAt: new Date(now.getTime() + i),
      updatedAt: new Date(now.getTime() + i),
    })),
  );
}

async function markPromoted(tx: Tx, tenantId: string, actor: Actor, id: string, dealId: string, now: Date) {
  await tx
    .update(prospects)
    .set({ promotedDealId: dealId, promotedAt: now, promotedBy: actor.userId, lastActivityAt: now, updatedAt: now })
    .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)));
}

async function promotedActivity(tx: Tx, tenantId: string, actor: Actor, dealId: string, dealName: string, p: Prospect, linked: boolean) {
  await recordActivity(tx, {
    tenantId,
    actorUserId: actor.userId,
    entityType: 'deal',
    entityId: dealId,
    action: 'automation_note',
    metadata: { name: dealName, kind: 'prospect_promoted', message: 'Promoted from Prospect Board', prospectId: p.id, sourceTag: p.sourceTag, linked },
  });
}

/** What the post-commit step needs. */
type Committed = {
  dealId: string;
  dealName: string;
  linked: boolean;
  claimer: string | null;
  company: { id: string; name: string } | null;
  contact: { id: string; displayName: string } | null;
};

type TxResult = { outcome: PromoteOutcome; committed?: Committed };

export async function promoteProspect(
  tenantId: string,
  actor: Actor,
  id: string,
  choice: PromoteChoice = {},
  now: Date = new Date(),
  deps: PromoteDeps = {},
): Promise<PromoteOutcome> {
  return promoteOne(tenantId, actor, id, choice ?? {}, now, deps);
}

async function promoteOne(
  tenantId: string,
  actor: Actor,
  id: string,
  choice: PromoteChoice,
  now: Date,
  deps: PromoteDeps,
  scopeIn?: ReportScope | null,
): Promise<PromoteOutcome> {
  if (!UUID_RE.test(id)) return fail('not_found');
  const picked = [choice.leadId, choice.companyId, choice.contactId].filter((v): v is string => v != null && v !== '');
  if (picked.some((v) => !UUID_RE.test(v))) return fail('invalid');
  if (choice.leadId && (choice.companyId || choice.contactId)) return fail('invalid', PROMOTE_MESSAGES.both);

  // Scope reads memberships, not the prospect, so it is resolved before the lock.
  const scope = scopeIn !== undefined ? scopeIn : actor.role === 'manager' ? await scopeUsers({ tenantId, userId: actor.userId, role: actor.role }) : null;

  const res = await tenantTransaction(async (tx): Promise<TxResult> => {
    const [cur] = await tx
      .select()
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.id, id)))
      .limit(1)
      .for('update');
    if (!cur) return { outcome: fail('not_found') };
    const holderInScope = !cur.claimedBy || !scope || scope.userIds === null || scope.userIds.includes(cur.claimedBy);
    const block = promoteBlock(cur, actor, { holderInScope }, now);
    if (block) return { outcome: fail(block) };
    if (choice.createAnyway && !canCreateAnyway(actor.role)) return { outcome: fail('no_permission') };

    // Candidates are read inside the locked transaction.
    const candidates = await findPromoteCandidates(tenantId, cur, tx);
    const isCandidate = (kind: MatchCandidate['kind'], cid: string | undefined) =>
      !cid || candidates.some((c) => c.kind === kind && c.id === cid);
    if (!isCandidate('open_lead', choice.leadId) || !isCandidate('company', choice.companyId) || !isCandidate('contact', choice.contactId)) {
      return { outcome: fail('invalid') };
    }

    let pickedContact: { id: string; companyId: string | null } | null = null;
    if (choice.contactId) {
      const [c] = await tx
        .select({ id: contacts.id, companyId: contacts.companyId })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, choice.contactId)))
        .limit(1);
      if (!c) return { outcome: fail('invalid') };
      pickedContact = c;
    }
    // A picked company and contact must agree.
    if (choice.companyId && pickedContact?.companyId && pickedContact.companyId !== choice.companyId) {
      return { outcome: fail('invalid', PROMOTE_MESSAGES.contact_company) };
    }

    if (picked.length === 0 && !choice.createAnyway) {
      if (candidates.some((c) => c.strength === 'strong')) return { outcome: { status: 'blocked', candidates } };
      if (candidates.length > 0 && !choice.ignoreWarnings) return { outcome: { status: 'warn', candidates } };
    }
    // Without a lead or "create anyway", the picks must cover every kind that has
    // strong matches. A weak pick never covers a strong kind; a picked contact's
    // company covers the company kind only when it is itself a strong match.
    if (picked.length > 0 && !choice.leadId && !choice.createAnyway) {
      const strongIds = (kind: MatchCandidate['kind']) =>
        candidates.filter((c) => c.kind === kind && c.strength === 'strong').map((c) => c.id);
      const strongCompanies = strongIds('company');
      const strongContacts = strongIds('contact');
      const effectiveCompany = choice.companyId ?? pickedContact?.companyId ?? null;
      const companyCovered = strongCompanies.length === 0 || (!!effectiveCompany && strongCompanies.includes(effectiveCompany));
      const contactCovered = strongContacts.length === 0 || (!!choice.contactId && strongContacts.includes(choice.contactId));
      if (!companyCovered || !contactCovered) return { outcome: { status: 'blocked', candidates } };
    }

    const bodies = await noteBodies(tx, tenantId, cur);

    /* ---- link an existing open lead ---- */
    if (choice.leadId) {
      const [lead] = await tx
        .select({ id: deals.id, name: deals.name, stage: deals.stage, deletedAt: deals.deletedAt })
        .from(deals)
        .where(and(eq(deals.tenantId, tenantId), eq(deals.id, choice.leadId)))
        .for('update');
      if (!lead || lead.deletedAt || lead.stage !== 'lead') return { outcome: fail('invalid') };
      const [taken] = await tx
        .select({ id: prospects.id })
        .from(prospects)
        .where(and(eq(prospects.tenantId, tenantId), eq(prospects.promotedDealId, lead.id), ne(prospects.id, cur.id)))
        .limit(1);
      if (taken) return { outcome: fail('invalid', PROMOTE_MESSAGES.lead_taken) };
      await insertNotes(tx, tenantId, actor, lead.id, bodies, now);
      await promotedActivity(tx, tenantId, actor, lead.id, lead.name, cur, true);
      await markPromoted(tx, tenantId, actor, cur.id, lead.id, now);
      return {
        outcome: { status: 'promoted', dealId: lead.id, linked: true, routing: 'none' },
        committed: { dealId: lead.id, dealName: lead.name, linked: true, claimer: null, company: null, contact: null },
      };
    }

    /* ---- create company / contact / lead ---- */
    const [offering] = cur.productFitOfferingId
      ? await tx
          .select({ name: offerings.name })
          .from(offerings)
          .where(and(eq(offerings.tenantId, tenantId), eq(offerings.id, cur.productFitOfferingId)))
          .limit(1)
      : [];
    const productInterest = offering?.name ?? null;

    const sourceId = await ensureProspectBoardSource(tx, tenantId, actor.userId);

    // Company: picked, else the picked contact's company, else a new one.
    let companyId = choice.companyId ?? pickedContact?.companyId ?? null;
    let createdCompany: Committed['company'] = null;
    if (!companyId) {
      const [co] = await tx
        .insert(companies)
        .values({
          tenantId,
          name: cur.companyName,
          normalizedName: normalizeCompanyName(cur.companyName),
          domain: cur.domain,
          industry: cur.industry,
          ownerId: null,
          updatedBy: actor.userId,
          dedupOverride: !!choice.createAnyway,
        })
        .returning();
      companyId = co!.id;
      createdCompany = { id: co!.id, name: co!.name };
      await recordActivity(tx, { tenantId, actorUserId: actor.userId, entityType: 'company', entityId: co!.id, action: 'created', metadata: { name: co!.name } });
      if (choice.createAnyway) {
        await recordActivity(tx, { tenantId, actorUserId: actor.userId, entityType: 'company', entityId: co!.id, action: 'dedup_override', metadata: { name: co!.name } });
      }
      await publishRealtimeEvent(tx, { type: 'company.created', tenantId, company: serializeCompany(co!) });
    }

    let contactId = pickedContact?.id ?? null;
    let createdContact: Committed['contact'] = null;
    if (!contactId) {
      const full = cur.contactName?.trim() ?? '';
      const parts = full ? full.split(/\s+/) : [];
      const firstName = parts[0] ?? null;
      const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
      const [ct] = await tx
        .insert(contacts)
        .values({
          tenantId,
          companyId,
          firstName,
          lastName,
          email: cur.contactEmail,
          phone: cur.contactPhone,
          title: cur.contactDesignation,
          ownerId: null,
          updatedBy: actor.userId,
          normalizedName: normalizeContactName(firstName, lastName) || null,
          emailNormalized: cur.emailNormalized,
          phoneNormalized: cur.phoneNormalized,
        })
        .returning();
      contactId = ct!.id;
      const displayName = full || cur.contactEmail || cur.contactPhone || 'Contact';
      createdContact = { id: ct!.id, displayName };
      await recordActivity(tx, { tenantId, actorUserId: actor.userId, entityType: 'contact', entityId: ct!.id, action: 'created', metadata: { name: displayName } });
      await publishRealtimeEvent(tx, { type: 'contact.created', tenantId, contact: serializeContact(ct!) });
    }

    const dealName = productInterest ? `${cur.companyName} – ${productInterest}` : cur.companyName;
    const [deal] = await tx
      .insert(deals)
      .values({
        tenantId,
        companyId,
        contactId,
        name: dealName,
        companyNameText: cur.companyName,
        contactNameText: cur.contactName,
        contactEmailText: cur.emailNormalized,
        stage: 'lead',
        currency: 'INR',
        source: `Prospect Board: ${cur.sourceTag}`,
        leadSourceId: sourceId,
        leadCity: cur.city,
        leadState: cur.state,
        leadProductInterest: productInterest,
        sourceProspectId: cur.id,
        ownerId: null,
        routingStatus: 'pending',
        routingQueuedAt: now,
        updatedBy: actor.userId,
      })
      .returning({ id: deals.id });
    const dealId = deal!.id;

    await insertNotes(tx, tenantId, actor, dealId, bodies, now);
    await promotedActivity(tx, tenantId, actor, dealId, dealName, cur, false);
    const serialized = await loadSerializedDeal(tx, tenantId, dealId);
    if (serialized) await publishRealtimeEvent(tx, { type: 'deal.created', tenantId, deal: serialized });
    await markPromoted(tx, tenantId, actor, cur.id, dealId, now);

    // The claimer gets the lead only while the claim is live and they can still claim.
    let claimer: string | null = null;
    if (cur.claimedBy && isClaimActive(cur, now)) {
      const [mem] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, cur.claimedBy), eq(memberships.status, 'active')))
        .limit(1);
      if (mem && can(mem.role, 'claimProspects')) claimer = cur.claimedBy;
    }

    return {
      outcome: { status: 'promoted', dealId, linked: false, routing: 'retry' },
      committed: { dealId, dealName, linked: false, claimer, company: createdCompany, contact: createdContact },
    };
  });

  if (res.outcome.status !== 'promoted' || !res.committed) return res.outcome;
  const c = res.committed;
  const send = deps.sendEvent ?? sendWorkflowEvent;

  if (c.linked) {
    await send('crm/deal.health_recompute', { tenantId, dealId: c.dealId, reason: 'prospect_linked' });
    return res.outcome;
  }

  const routing = await routeLead(tenantId, actor, c, deps);

  // Post-commit, best-effort (sendWorkflowEvent swallows its own failures).
  await send('crm/deal.created', { tenantId, dealId: c.dealId, actorUserId: actor.userId, name: c.dealName, stage: 'lead' });
  await send('crm/deal.health_recompute', { tenantId, dealId: c.dealId, reason: 'created' });
  await send('crm/ai.embed_entity', { tenantId, entityType: 'deal', entityId: c.dealId, actorUserId: actor.userId, reason: 'created' });
  if (c.company) {
    await send('crm/company.created', { tenantId, companyId: c.company.id, actorUserId: actor.userId, name: c.company.name });
    await send('crm/ai.embed_entity', { tenantId, entityType: 'company', entityId: c.company.id, actorUserId: actor.userId, reason: 'created' });
  }
  if (c.contact) {
    await send('crm/contact.created', { tenantId, contactId: c.contact.id, actorUserId: actor.userId, displayName: c.contact.displayName });
    await send('crm/ai.embed_entity', { tenantId, entityType: 'contact', entityId: c.contact.id, actorUserId: actor.userId, reason: 'created' });
  }
  return { ...res.outcome, routing };
}

/**
 * After commit: a live claimer gets the lead via `reassignLead` (which sends
 * the "Lead assigned to you" notification when the claimer is not the
 * promoter); otherwise the distribution rules run. A throw leaves the lead
 * `routing_status = 'pending'` for the unassigned-retry job.
 */
async function routeLead(tenantId: string, actor: Actor, c: Committed, deps: PromoteDeps): Promise<PromoteRouting> {
  const distribute = deps.distribute ?? distributeLead;
  const reassign = deps.reassign ?? reassignLead;
  const send = deps.sendEvent ?? sendWorkflowEvent;
  let outcome: DistributeOutcome;
  try {
    if (c.claimer) {
      const r = await reassign({ tenantId, dealId: c.dealId, toUserId: c.claimer, actorUserId: actor.userId, reason: 'Claimed on Prospect Board' });
      if (r.ok) {
        // The claimer has already worked the prospect: count it as the first
        // touch so the SLA watchdog (keyed on first_touch_at IS NULL) never
        // takes the lead back. Best-effort; the assignment itself stands.
        try {
          await tenantTransaction((tx) =>
            tx
              .update(leadAssignments)
              .set({ firstTouchAt: new Date() })
              .where(and(eq(leadAssignments.tenantId, tenantId), eq(leadAssignments.dealId, c.dealId), isNull(leadAssignments.releasedAt), isNull(leadAssignments.firstTouchAt))),
          );
        } catch (err) {
          captureError(err, { category: 'prospects.promote.first_touch', retryable: false, fields: { tenantId, dealId: c.dealId } });
        }
        return 'claimer';
      }
      logger.warn('promote: claimer routing refused, distributing instead', { tenantId, dealId: c.dealId, error: r.error });
    }
    outcome = await distribute({ tenantId, dealId: c.dealId });
  } catch (err) {
    captureError(err, { category: 'prospects.promote.routing', retryable: true, fields: { tenantId, dealId: c.dealId } });
    return 'retry';
  }

  // Same follow-ups as the lead-distribute workflow; failures here never change the outcome.
  try {
    if (outcome.status === 'assigned') {
      await notifyAssigned(tenantId, outcome, c.dealName, 'New lead assigned to you');
      await send('crm/lead.assigned', { tenantId, dealId: c.dealId, userId: outcome.userId, ruleId: outcome.ruleId, slaDueAt: outcome.slaDueAt.toISOString() });
    } else if (outcome.status === 'unassigned') {
      await recordNotificationsSafe(
        {
          tenantId,
          actorUserId: null,
          type: 'lead_unassigned',
          title: `Lead needs an owner: ${c.dealName}`,
          subtitle: outcome.reason,
          entityType: 'deal',
          entityId: c.dealId,
        },
        await listLeadManagers(tenantId),
      );
      await send('crm/lead.unassigned', { tenantId, dealId: c.dealId, reason: outcome.reason });
    }
  } catch (err) {
    captureError(err, { category: 'prospects.promote.notify', retryable: false, fields: { tenantId, dealId: c.dealId } });
  }

  if (outcome.status === 'assigned') return 'distributed';
  if (outcome.status === 'queued') return 'queued';
  // 'unassigned', or 'skipped' (nothing to do): the lead waits in the unassigned queue.
  return 'unassigned';
}

export async function bulkPromote(
  tenantId: string,
  actor: Actor,
  ids: string[],
  opts: { ignoreWarnings?: boolean },
  deps: PromoteDeps = {},
): Promise<{ results: { id: string; outcome: PromoteOutcome }[] }> {
  if (ids.length > MAX_BULK_PROMOTE) return { results: ids.map((id) => ({ id, outcome: fail('invalid', PROMOTE_MESSAGES.too_many) })) };
  const scope = actor.role === 'manager' ? await scopeUsers({ tenantId, userId: actor.userId, role: actor.role }) : null;
  const results: { id: string; outcome: PromoteOutcome }[] = [];
  for (const id of ids) {
    try {
      results.push({ id, outcome: await promoteOne(tenantId, actor, id, { ignoreWarnings: opts.ignoreWarnings }, new Date(), deps, scope) });
    } catch (err) {
      console.error('bulkPromote: promote failed', id, err);
      results.push({ id, outcome: fail('error') });
    }
  }
  return { results };
}
