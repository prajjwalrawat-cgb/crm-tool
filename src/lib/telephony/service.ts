import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import {
  callCampaignItems,
  callRecordingAccess,
  calls,
  contacts,
  deals,
  memberships,
  tasks,
  userPhoneMapping,
  userRoutingProfile,
  type AgentStatus,
  type CallDisposition,
  type CallRow,
  type MembershipRole,
} from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { distributeLead } from '@/lib/lead-capture/distribute';
import { normalizePhone } from '@/lib/lead-capture/normalize';
import { recordNotificationsSafe } from '@/lib/notifications/recorder';
import { logger } from '@/lib/observability';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

import { addDnc, getActiveAccountRow, getTelephonySettings, isDnc, toAccountContext } from './accounts';
import { isWithinCallingHours } from './calling-hours';
import { getProvider } from './providers';
import { DISPOSITION_LABELS, formatDuration } from './serialize';
import { isTerminal, keep, mergeStatus } from './status';
import { TelephonyError, type NormalizedCallEvent } from './types';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Seconds below which a call may be closed without a real disposition. */
export const SKIP_DISPOSITION_MAX_SEC = 5;

/* ------------------------------------------------------------------ access */

/**
 * Who may see a call (and play its recording): reps see their own calls;
 * managers, admins and owners see every call in the workspace (there is no
 * team hierarchy yet — see BUILD_NOTES). Viewers see their own only.
 */
export function canSeeAllCalls(role: MembershipRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'manager';
}

export function callScopeWhere(tenantId: string, viewer: { userId: string; role: MembershipRole }): SQL {
  return canSeeAllCalls(viewer.role)
    ? eq(calls.tenantId, tenantId)
    : and(eq(calls.tenantId, tenantId), eq(calls.userId, viewer.userId))!;
}

export function webhookUrl(provider: string, accountId: string, secret: string): string {
  const base = (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/public/telephony/${provider}/${accountId}/webhook?s=${encodeURIComponent(secret)}`;
}

/* ------------------------------------------------------------- click-to-call */

export type ClickToCallInput = {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  leadId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  /** Managers may dial outside calling hours after confirming. */
  overrideHours?: boolean;
  campaignId?: string | null;
  campaignItemId?: string | null;
  /**
   * Set by the dialer only: the campaign assigned this lead to the agent and
   * already checked the campaign's own calling hours, so the per-call
   * ownership and workspace-hours checks don't apply. DNC still does.
   */
  fromCampaign?: boolean;
};

/**
 * Start an outbound call. The `calls` row is committed BEFORE the provider is
 * asked to dial, so the provider's first webhook always finds it (it carries
 * our id back in CustomField). Must run inside a tenant context.
 */
export async function clickToCall(input: ClickToCallInput): Promise<{ callId: string }> {
  const { tenantId, userId, role } = input;
  const prepared = await tenantTransaction(async (tx) => {
    const settings = await getTelephonySettings(tx, tenantId);
    const accountRow = await getActiveAccountRow(tx, tenantId);
    if (!accountRow) throw new TelephonyError('Telephony is not set up for this workspace.', 'not_configured');
    const [mapping] = await tx
      .select()
      .from(userPhoneMapping)
      .where(and(eq(userPhoneMapping.tenantId, tenantId), eq(userPhoneMapping.userId, userId)));
    if (!mapping) throw new TelephonyError('Your phone number is not set up for calling. Ask an admin to map it in Settings → Telephony.', 'no_agent_phone');

    // Resolve the number and the lead.
    const leadId = input.leadId ?? null;
    let contactId = input.contactId ?? null;
    let raw = input.phone ?? null;
    let ownerId: string | null = null;
    if (leadId) {
      const [d] = await tx
        .select({ id: deals.id, ownerId: deals.ownerId, contactId: deals.contactId, deletedAt: deals.deletedAt })
        .from(deals)
        .where(and(eq(deals.id, leadId), eq(deals.tenantId, tenantId)));
      if (!d || d.deletedAt) throw new TelephonyError('Lead not found.', 'not_found');
      ownerId = d.ownerId;
      contactId = contactId ?? d.contactId;
    }
    if (contactId && !raw) {
      const [c] = await tx
        .select({ phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
      raw = c?.phone ?? null;
    }
    const customer = normalizePhone(raw);
    if (!customer) throw new TelephonyError('No valid phone number to call.', 'invalid_number');

    if (!input.fromCampaign && ownerId && ownerId !== userId && !canSeeAllCalls(role)) {
      throw new TelephonyError('This lead belongs to another rep.', 'not_owner');
    }
    if (settings.enforceDnc && (await isDnc(tx, tenantId, customer))) {
      throw new TelephonyError('This number is on the do-not-call list.', 'dnc');
    }
    if (!input.fromCampaign && !isWithinCallingHours(settings.callingHours)) {
      if (!canSeeAllCalls(role)) {
        throw new TelephonyError(`Outside calling hours (${settings.callingHours.start}–${settings.callingHours.end}).`, 'outside_hours');
      }
      if (!input.overrideHours) {
        throw new TelephonyError('Outside calling hours. Confirm to call anyway.', 'outside_hours');
      }
    }

    const account = toAccountContext(accountRow);
    const callerId = account.virtualNumbers[0];
    if (!callerId) throw new TelephonyError('The telephony account has no caller id (virtual number).', 'not_configured');

    const callId = randomUUID();
    await tx.insert(calls).values({
      id: callId,
      tenantId,
      accountId: account.id,
      provider: account.provider,
      providerCallId: `pending:${callId}`,
      direction: 'outbound',
      leadId,
      contactId,
      userId,
      fromNumber: callerId,
      toNumber: customer,
      fromNumberNormalized: normalizePhone(callerId),
      toNumberNormalized: customer,
      status: 'initiated',
      startedAt: new Date(),
      campaignId: input.campaignId ?? null,
      campaignItemId: input.campaignItemId ?? null,
      consentPolicyVersion: settings.consentPolicyVersion,
      createdBy: userId,
    });
    return { callId, account, agentPhone: mapping.agentPhone, customer, callerId, record: settings.recordCalls };
  });

  const provider = getProvider(prepared.account.provider);
  try {
    const { providerCallId } = await provider.clickToCall({
      account: prepared.account,
      agentPhone: prepared.agentPhone,
      customerPhone: prepared.customer,
      callerId: prepared.callerId,
      record: prepared.record,
      statusCallbackUrl: webhookUrl(prepared.account.provider, prepared.account.id, prepared.account.webhookSecret),
      customData: { callId: prepared.callId, tenantId },
    });
    await tenantTransaction((tx) =>
      tx
        .update(calls)
        .set({ providerCallId })
        .where(and(eq(calls.id, prepared.callId), sql`${calls.providerCallId} like 'pending:%'`)),
    );
  } catch (err) {
    await tenantTransaction((tx) =>
      tx
        .update(calls)
        .set({ status: 'failed', endedAt: new Date(), notes: err instanceof Error ? err.message.slice(0, 500) : 'provider error' })
        .where(eq(calls.id, prepared.callId)),
    );
    throw err instanceof TelephonyError ? err : new TelephonyError('The call could not be started.', 'provider_error');
  }
  logger.info('click-to-call started', { tenantId, callId: prepared.callId });
  return { callId: prepared.callId };
}

/* ------------------------------------------------------------ webhook events */

export type ProcessedCallEvent = {
  callId: string;
  becameTerminal: boolean;
  hasRecordingUrl: boolean;
  /** Stub lead created for an unknown inbound caller; needs distribution. */
  stubLeadId: string | null;
  inboundRinging: boolean;
};

/**
 * Apply one normalized provider event. Idempotent and order-independent:
 *  - upsert by (tenant, provider, provider_call_id), falling back to our id in
 *    CustomField for the first event after click-to-call;
 *  - status only moves forward (status.ts); fields only fill in, never blank;
 *  - side effects (timeline entry, first touch, missed-call task, campaign
 *    bookkeeping) run once, on the transition INTO a terminal status.
 * Must run inside runWithSystemContext(tenantId).
 */
export async function processCallEvent(args: {
  tenantId: string;
  accountId: string | null;
  provider: CallRow['provider'];
  event: NormalizedCallEvent;
}): Promise<ProcessedCallEvent> {
  const { tenantId, provider, event } = args;
  const result = await tenantTransaction(async (tx) => {
    let row = await findCallForEvent(tx, tenantId, provider, event);
    let stubLeadId: string | null = null;
    let isNewRow = false;

    if (!row) {
      const created = await createCallFromEvent(tx, { ...args });
      row = created.row;
      stubLeadId = created.stubLeadId;
      isNewRow = created.inserted;
    }
    const before = row;
    const status = mergeStatus(before.status, event.status);
    const now = new Date();
    const answeredAt = keep(before.answeredAt, event.answeredAt ?? (status === 'answered' && !before.answeredAt ? now : null));
    const endedAt = isTerminal(status) ? keep(before.endedAt, event.endedAt ?? now) : before.endedAt;
    const startedAt = keep(before.startedAt, event.startedAt);
    const talk = keep(before.talkTimeSec, event.talkTimeSec);
    const duration = keep(before.durationSec, event.durationSec ?? (startedAt && endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : null));

    const [after] = await tx
      .update(calls)
      .set({
        providerCallId: before.providerCallId.startsWith('pending:') ? event.providerCallId : before.providerCallId,
        status,
        startedAt,
        answeredAt,
        endedAt,
        talkTimeSec: talk,
        durationSec: duration,
        recordingUrl: keep(before.recordingUrl, event.recordingUrl),
      })
      .where(eq(calls.id, before.id))
      .returning();

    const becameTerminal = !isTerminal(before.status) && isTerminal(status);
    const missed = becameTerminal ? await onCallEnded(tx, after!) : null;

    if (after!.userId) {
      await publishRealtimeEvent(tx, {
        type: 'call.updated',
        tenantId,
        recipientUserId: after!.userId,
        callId: after!.id,
        status,
        leadId: after!.leadId,
        endedAt: after!.endedAt?.toISOString() ?? null,
        needsDisposition: isTerminal(status) && !after!.disposition,
      });
    }
    return {
      call: after!,
      stubLeadId,
      becameTerminal,
      missed,
      // First event of an inbound call that is still live: pop the owner's screen.
      inboundRinging: after!.direction === 'inbound' && isNewRow && !isTerminal(status),
    };
  });

  if (result.missed) await notifyMissedCall(result.missed);

  // Unknown inbound caller: distribute the stub lead right away so the popup
  // reaches whoever now owns it.
  let call = result.call;
  if (result.stubLeadId) {
    const outcome = await distributeLead({ tenantId, dealId: result.stubLeadId });
    if (outcome.status === 'assigned') {
      call = await tenantTransaction(async (tx) => {
        const [u] = await tx.update(calls).set({ userId: call.userId ?? outcome.userId }).where(eq(calls.id, call.id)).returning();
        return u!;
      });
    }
  }
  if (call.direction === 'inbound' && (result.stubLeadId || result.inboundRinging)) {
    await publishInboundPopup(tenantId, call, !!result.stubLeadId);
  }
  return {
    callId: call.id,
    becameTerminal: result.becameTerminal,
    hasRecordingUrl: !!call.recordingUrl,
    stubLeadId: result.stubLeadId,
    inboundRinging: result.inboundRinging,
  };
}

async function findCallForEvent(tx: DrizzleTx, tenantId: string, provider: CallRow['provider'], event: NormalizedCallEvent): Promise<CallRow | null> {
  const [byProvider] = await tx
    .select()
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.provider, provider), eq(calls.providerCallId, event.providerCallId)))
    .for('update');
  if (byProvider) return byProvider;
  if (event.customData && /^[0-9a-f-]{36}$/i.test(event.customData)) {
    const [byOurId] = await tx
      .select()
      .from(calls)
      .where(and(eq(calls.tenantId, tenantId), eq(calls.id, event.customData)))
      .for('update');
    if (byOurId) return byOurId;
  }
  return null;
}

async function createCallFromEvent(
  tx: DrizzleTx,
  args: { tenantId: string; accountId: string | null; provider: CallRow['provider']; event: NormalizedCallEvent },
): Promise<{ row: CallRow; stubLeadId: string | null; inserted: boolean }> {
  const { tenantId, provider, event } = args;
  const direction = event.direction ?? 'inbound';
  const from = event.from ?? 'unknown';
  const to = event.to ?? 'unknown';
  const fromN = normalizePhone(from);
  const toN = normalizePhone(to);
  const customerN = direction === 'inbound' ? fromN : toN;

  // Match the customer to a lead; the agent to a user by their mapped phone.
  let leadId: string | null = null;
  let contactId: string | null = null;
  let ownerId: string | null = null;
  let stubLeadId: string | null = null;
  if (customerN) {
    const [m] = await tx
      .select({ contactId: contacts.id, dealId: deals.id, ownerId: deals.ownerId })
      .from(contacts)
      .leftJoin(deals, and(eq(deals.contactId, contacts.id), isNull(deals.deletedAt)))
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneNormalized, customerN), isNull(contacts.deletedAt), isNull(contacts.mergedIntoId)))
      .orderBy(sql`${deals.id} is null`, desc(deals.updatedAt))
      .limit(1);
    if (m) {
      contactId = m.contactId;
      leadId = m.dealId;
      ownerId = m.ownerId;
    }
  }
  let agentUserId: string | null = null;
  const agentN = normalizePhone(event.agentPhone);
  if (agentN) {
    const [a] = await tx
      .select({ userId: userPhoneMapping.userId })
      .from(userPhoneMapping)
      .where(and(eq(userPhoneMapping.tenantId, tenantId), eq(userPhoneMapping.agentPhone, agentN)));
    agentUserId = a?.userId ?? null;
  }

  if (direction === 'inbound' && !leadId && customerN) {
    // Unknown caller: stub contact + lead, routed like any captured lead.
    if (!contactId) {
      const [c] = await tx
        .insert(contacts)
        .values({ tenantId, phone: from, phoneNormalized: customerN, updatedBy: 'system' })
        .returning({ id: contacts.id });
      contactId = c!.id;
    }
    const [d] = await tx
      .insert(deals)
      .values({
        tenantId,
        contactId,
        name: `Inbound call – ${customerN}`,
        stage: 'lead',
        currency: 'INR',
        source: 'Inbound call',
        routingStatus: 'pending',
        routingQueuedAt: new Date(),
        lastEnquiryAt: new Date(),
        updatedBy: 'system',
      })
      .returning({ id: deals.id });
    leadId = d!.id;
    stubLeadId = d!.id;
    await recordActivity(tx, {
      tenantId,
      actorUserId: null,
      entityType: 'deal',
      entityId: leadId,
      action: 'automation_note',
      metadata: { name: `Inbound call – ${customerN}`, kind: 'lead_captured', message: 'Lead created from an inbound call' },
    });
  }

  const inserted = await tx
    .insert(calls)
    .values({
      tenantId,
      accountId: args.accountId,
      provider,
      providerCallId: event.providerCallId,
      direction,
      leadId,
      contactId,
      userId: agentUserId ?? ownerId,
      fromNumber: from,
      toNumber: to,
      fromNumberNormalized: fromN,
      toNumberNormalized: toN,
      status: 'initiated',
      startedAt: event.startedAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [calls.tenantId, calls.provider, calls.providerCallId] })
    .returning();
  // Lost a race with a concurrent duplicate webhook: lock the winner instead.
  const row =
    inserted[0] ??
    (
      await tx
        .select()
        .from(calls)
        .where(and(eq(calls.tenantId, tenantId), eq(calls.provider, provider), eq(calls.providerCallId, event.providerCallId)))
        .for('update')
    )[0]!;
  return { row, stubLeadId: inserted[0] ? stubLeadId : null, inserted: !!inserted[0] };
}

type MissedCall = { tenantId: string; owner: string; callId: string; leadId: string | null; from: string; taskId: string };

/**
 * Side effects of a call ending. Runs once per call, in the event's
 * transaction. Returns the missed-call notification to send after commit.
 */
async function onCallEnded(tx: DrizzleTx, call: CallRow): Promise<MissedCall | null> {
  let missed: MissedCall | null = null;
  const label =
    call.status === 'completed'
      ? `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${formatDuration(call.talkTimeSec ?? call.durationSec)}`
      : `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${call.status.replace('_', ' ')}`;

  if (call.leadId) {
    await recordActivity(tx, {
      tenantId: call.tenantId,
      actorUserId: call.userId,
      entityType: 'deal',
      entityId: call.leadId,
      action: 'call_logged',
      metadata: {
        notes: label,
        callId: call.id,
        direction: call.direction,
        status: call.status,
        talkTimeSec: call.talkTimeSec,
        source: 'telephony',
      },
    });
    // First touch: an outbound call by the owner counts whether or not the
    // customer answered (it was attempted). The recorder hook covers the
    // owner case; this also covers a call with no recorded actor.
    if (call.direction === 'outbound' && call.userId) {
      await tx.execute(sql`
        update lead_assignments set first_touch_at = now()
        where deal_id = ${call.leadId} and released_at is null and first_touch_at is null
          and assigned_to = ${call.userId}`);
    }
  }

  // Missed inbound: a callback task for the owner, due now (+15 min in the title).
  if (call.direction === 'inbound' && ['missed', 'no_answer', 'busy', 'failed'].includes(call.status)) {
    let owner = call.userId;
    if (!owner && call.leadId) {
      const [d] = await tx.select({ o: deals.ownerId }).from(deals).where(eq(deals.id, call.leadId));
      owner = d?.o ?? null;
    }
    const due = new Date(Date.now() + 15 * 60_000);
    const [t] = await tx
      .insert(tasks)
      .values({
        tenantId: call.tenantId,
        title: `Call back ${call.fromNumber} (missed call, by ${due.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })})`,
        type: 'call',
        priority: 'high',
        dueDate: due.toISOString().slice(0, 10),
        assignedUserId: owner,
        createdBy: 'system',
        entityType: call.leadId ? 'deal' : null,
        entityId: call.leadId,
      })
      .returning({ id: tasks.id });
    if (owner) missed = { tenantId: call.tenantId, owner, callId: call.id, leadId: call.leadId, from: call.fromNumber, taskId: t!.id };
  }

  // Dialer bookkeeping for unanswered campaign calls; answered ones wait for
  // the disposition (saveDisposition closes them).
  if (call.campaignItemId && call.status !== 'completed') {
    await requeueCampaignItem(tx, call.campaignItemId, call.status, call.id);
  }
  return missed;
}

/** Missed-call notification, sent after commit (best-effort, never throws). */
async function notifyMissedCall(n: MissedCall): Promise<void> {
  {
    await runWithSystemContext(n.tenantId, () =>
      recordNotificationsSafe(
        {
          tenantId: n.tenantId,
          actorUserId: null,
          type: 'call_missed',
          title: `Missed call from ${n.from}`,
          subtitle: 'Call back within 15 minutes.',
          entityType: n.leadId ? 'deal' : 'task',
          entityId: n.leadId ?? n.taskId,
          metadata: { callId: n.callId, taskId: n.taskId },
        },
        [n.owner],
      ),
    );
  }
}

async function requeueCampaignItem(tx: DrizzleTx, itemId: string, outcome: string, callId: string): Promise<void> {
  await tx.execute(sql`
    update call_campaign_items i set
      state = case when i.attempts >= c.max_attempts then 'done' else 'pending' end,
      next_attempt_at = case when i.attempts >= c.max_attempts then null else now() + make_interval(mins => c.retry_gap_minutes) end,
      locked_by = null, locked_until = null, last_outcome = ${outcome}, last_call_id = ${callId}, updated_at = now()
    from call_campaigns c
    where i.id = ${itemId} and c.id = i.campaign_id and i.state in ('locked', 'pending')`);
}

async function publishInboundPopup(tenantId: string, call: CallRow, isNewLead: boolean): Promise<void> {
  await tenantTransaction(async (tx) => {
    let leadName: string | null = null;
    let companyName: string | null = null;
    let contactName: string | null = null;
    let ownerId: string | null = null;
    let lastInteraction: string | null = null;
    if (call.leadId) {
      const [d] = await tx
        .select({ name: deals.name, company: deals.companyNameText, ownerId: deals.ownerId, contactName: deals.contactNameText })
        .from(deals)
        .where(eq(deals.id, call.leadId));
      leadName = d?.name ?? null;
      companyName = d?.company ?? null;
      ownerId = d?.ownerId ?? null;
      contactName = d?.contactName ?? null;
      const [last] = await tx.execute<{ created_at: Date }>(sql`
        select created_at from activity_logs where tenant_id = ${tenantId} and entity_type = 'deal' and entity_id = ${call.leadId}
        order by created_at desc offset 1 limit 1`);
      lastInteraction = last?.created_at ? new Date(last.created_at).toISOString() : null;
    }
    if (call.contactId && !contactName) {
      const [c] = await tx.select({ f: contacts.firstName, l: contacts.lastName }).from(contacts).where(eq(contacts.id, call.contactId));
      contactName = [c?.f, c?.l].filter(Boolean).join(' ') || null;
    }
    const recipients = [...new Set([call.userId, ownerId].filter((u): u is string => !!u))];
    for (const recipientUserId of recipients) {
      await publishRealtimeEvent(tx, {
        type: 'call.inbound',
        tenantId,
        recipientUserId,
        call: { id: call.id, fromNumber: call.fromNumber, leadId: call.leadId, leadName, companyName, contactName, ownerId, lastInteraction, isNewLead },
      });
    }
  });
}

/* --------------------------------------------------------------- disposition */

export async function saveDisposition(args: {
  tenantId: string;
  userId: string;
  role: MembershipRole;
  callId: string;
  disposition: CallDisposition;
  notes: string | null;
  callbackAt: Date | null;
}): Promise<{ ok: true; taskId: string | null } | { ok: false; error: string }> {
  const { tenantId, userId, role, callId, disposition } = args;
  return await tenantTransaction(async (tx) => {
    const [call] = await tx.select().from(calls).where(and(eq(calls.id, callId), eq(calls.tenantId, tenantId))).for('update');
    if (!call) return { ok: false as const, error: 'Call not found.' };
    if (call.userId !== userId && !canSeeAllCalls(role)) return { ok: false as const, error: 'Not your call.' };
    if (disposition === 'skipped') {
      const secs = call.talkTimeSec ?? call.durationSec ?? 0;
      const connected = !!call.answeredAt || (call.talkTimeSec ?? 0) > 0;
      if (connected && secs >= SKIP_DISPOSITION_MAX_SEC) {
        return { ok: false as const, error: `Only calls under ${SKIP_DISPOSITION_MAX_SEC}s can be skipped. Pick a disposition.` };
      }
    }
    if (disposition === 'callback' && !args.callbackAt) return { ok: false as const, error: 'Pick a callback time.' };

    let taskId: string | null = null;
    if (disposition === 'callback' && args.callbackAt) {
      const [t] = await tx
        .insert(tasks)
        .values({
          tenantId,
          title: `Call back ${call.direction === 'outbound' ? call.toNumber : call.fromNumber} at ${args.callbackAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}`,
          type: 'call',
          priority: 'high',
          dueDate: args.callbackAt.toISOString().slice(0, 10),
          assignedUserId: call.userId ?? userId,
          createdBy: userId,
          entityType: call.leadId ? 'deal' : null,
          entityId: call.leadId,
          description: args.notes,
        })
        .returning({ id: tasks.id });
      taskId = t!.id;
    }
    if (disposition === 'do_not_call') {
      await addDnc(tx, {
        tenantId,
        phone: call.direction === 'outbound' ? call.toNumber : call.fromNumber,
        reason: 'Disposition: do not call',
        addedBy: userId,
      });
    }
    await tx
      .update(calls)
      .set({ disposition, dispositionAt: new Date(), notes: args.notes ?? call.notes, callbackAt: args.callbackAt })
      .where(eq(calls.id, callId));

    if (call.campaignItemId) {
      if (disposition === 'callback' && args.callbackAt) {
        await tx
          .update(callCampaignItems)
          .set({ state: 'pending', nextAttemptAt: args.callbackAt, lockedBy: null, lockedUntil: null, lastOutcome: disposition, updatedAt: new Date() })
          .where(and(eq(callCampaignItems.id, call.campaignItemId), inArray(callCampaignItems.state, ['locked', 'pending'])));
      } else if (['not_reachable'].includes(disposition)) {
        await requeueCampaignItem(tx, call.campaignItemId, disposition, call.id);
      } else if (disposition !== 'do_not_call') {
        await tx
          .update(callCampaignItems)
          .set({ state: 'done', lockedBy: null, lockedUntil: null, lastOutcome: disposition, lastCallId: call.id, updatedAt: new Date() })
          .where(and(eq(callCampaignItems.id, call.campaignItemId), inArray(callCampaignItems.state, ['locked', 'pending'])));
      }
    }
    if (call.leadId && disposition !== 'skipped') {
      await recordActivity(tx, {
        tenantId,
        actorUserId: userId,
        entityType: 'deal',
        entityId: call.leadId,
        action: 'automation_note',
        metadata: {
          kind: 'call_disposition',
          callId,
          message: `Call disposition: ${DISPOSITION_LABELS[disposition]}${args.notes ? ` — ${args.notes.slice(0, 200)}` : ''}`,
        },
      });
    }
    return { ok: true as const, taskId };
  });
}

/* -------------------------------------------------------------------- reads */

export async function listCallsScoped(args: {
  tenantId: string;
  viewer: { userId: string; role: MembershipRole };
  leadId?: string | null;
  userId?: string | null;
  from?: Date | null;
  to?: Date | null;
  direction?: 'outbound' | 'inbound' | null;
  status?: string | null;
  limit?: number;
}): Promise<CallRow[]> {
  const where: SQL[] = [callScopeWhere(args.tenantId, args.viewer)];
  if (args.leadId) where.push(eq(calls.leadId, args.leadId));
  if (args.userId) where.push(eq(calls.userId, args.userId));
  if (args.from) where.push(gte(calls.createdAt, args.from));
  if (args.to) where.push(lte(calls.createdAt, args.to));
  if (args.direction) where.push(eq(calls.direction, args.direction));
  if (args.status) where.push(eq(calls.status, args.status as CallRow['status']));
  return await tenantTransaction((tx) =>
    tx
      .select()
      .from(calls)
      .where(and(...where))
      .orderBy(desc(calls.createdAt))
      .limit(Math.min(args.limit ?? 100, 500)),
  );
}

/** One call the viewer may see, or null. */
export async function getCallScoped(tenantId: string, viewer: { userId: string; role: MembershipRole }, callId: string): Promise<CallRow | null> {
  const [row] = await tenantTransaction((tx) =>
    tx.select().from(calls).where(and(callScopeWhere(tenantId, viewer), eq(calls.id, callId))),
  );
  return row ?? null;
}

export async function logRecordingAccess(args: { tenantId: string; callId: string; userId: string; range: string | null }) {
  await tenantTransaction((tx) =>
    tx.insert(callRecordingAccess).values({ tenantId: args.tenantId, callId: args.callId, userId: args.userId, rangeHeader: args.range?.slice(0, 100) ?? null }),
  );
}

/** Softphone state for one agent: status, current call, a call awaiting a disposition. */
export async function getAgentState(tenantId: string, userId: string) {
  return await tenantTransaction(async (tx) => {
    const accountRow = await getActiveAccountRow(tx, tenantId);
    const [mapping] = await tx
      .select({ agentPhone: userPhoneMapping.agentPhone, agentStatus: userPhoneMapping.agentStatus })
      .from(userPhoneMapping)
      .where(and(eq(userPhoneMapping.tenantId, tenantId), eq(userPhoneMapping.userId, userId)));
    const [active] = await tx
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.tenantId, tenantId),
          eq(calls.userId, userId),
          inArray(calls.status, ['initiated', 'ringing', 'answered']),
          gte(calls.createdAt, sql`now() - interval '3 hours'`),
        ),
      )
      .orderBy(desc(calls.createdAt))
      .limit(1);
    const [pending] = await tx
      .select()
      .from(calls)
      .where(
        and(
          eq(calls.tenantId, tenantId),
          eq(calls.userId, userId),
          isNull(calls.disposition),
          isNotNull(calls.endedAt),
          gte(calls.createdAt, sql`now() - interval '24 hours'`),
          // Nothing to dispose for a call that failed before ringing anyone,
          // or an inbound call the agent never picked up (that one gets a
          // callback task instead).
          or(isNotNull(calls.answeredAt), sql`${calls.status} <> 'failed' and ${calls.direction} = 'outbound'`),
        ),
      )
      .orderBy(desc(calls.endedAt))
      .limit(1);
    let leadName: string | null = null;
    const focus = active ?? pending;
    if (focus?.leadId) {
      const [d] = await tx.select({ n: deals.name }).from(deals).where(eq(deals.id, focus.leadId));
      leadName = d?.n ?? null;
    }
    return {
      configured: !!accountRow,
      mapped: !!mapping,
      agentStatus: (mapping?.agentStatus ?? 'offline') as AgentStatus,
      activeCall: active ?? null,
      pendingDisposition: pending ?? null,
      leadName,
    };
  });
}

/** Softphone availability; 'available' also drives lead routing availability. */
export async function setAgentStatus(tenantId: string, userId: string, status: AgentStatus): Promise<{ ok: boolean; error?: string }> {
  return await tenantTransaction(async (tx) => {
    const rows = await tx
      .update(userPhoneMapping)
      .set({ agentStatus: status, statusChangedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(userPhoneMapping.tenantId, tenantId), eq(userPhoneMapping.userId, userId)))
      .returning({ u: userPhoneMapping.userId });
    if (rows.length === 0) return { ok: false, error: 'Your phone is not mapped yet. Ask an admin (Settings → Telephony).' };
    await tx
      .insert(userRoutingProfile)
      .values({ tenantId, userId, isAvailable: status === 'available' })
      .onConflictDoUpdate({
        target: [userRoutingProfile.tenantId, userRoutingProfile.userId],
        set: { isAvailable: status === 'available', updatedAt: new Date() },
      });
    return { ok: true };
  });
}

/** Turn the AI summary's suggested follow-up into a real task (one click). */
export async function acceptFollowUp(args: { tenantId: string; userId: string; role: MembershipRole; callId: string }) {
  return await tenantTransaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(calls)
      .where(and(callScopeWhere(args.tenantId, { userId: args.userId, role: args.role }), eq(calls.id, args.callId)))
      .for('update');
    if (!call) return { ok: false as const, error: 'Call not found.' };
    if (call.followUpTaskId) return { ok: true as const, taskId: call.followUpTaskId };
    const date = call.aiSummary?.follow_up_date;
    if (!date) return { ok: false as const, error: 'No follow-up date was suggested for this call.' };
    const [t] = await tx
      .insert(tasks)
      .values({
        tenantId: args.tenantId,
        title: `Follow up: ${call.aiSummary?.next_steps?.[0] ?? 'call follow-up'}`.slice(0, 200),
        description: call.aiSummary?.summary ?? null,
        type: 'followup',
        dueDate: date,
        assignedUserId: call.userId ?? args.userId,
        createdBy: args.userId,
        entityType: call.leadId ? 'deal' : null,
        entityId: call.leadId,
      })
      .returning({ id: tasks.id });
    await tx.update(calls).set({ followUpTaskId: t!.id }).where(eq(calls.id, call.id));
    return { ok: true as const, taskId: t!.id };
  });
}

/** Active members, for agent pickers. */
export async function listActiveMembers(tenantId: string) {
  return await tenantTransaction((tx) =>
    tx
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.status, 'active'))),
  );
}

