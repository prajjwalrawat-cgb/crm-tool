import 'server-only';

import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  callCampaignItems,
  callCampaigns,
  calls,
  userPhoneMapping,
  type CallCampaign,
  type CallCampaignItem,
  type CallingHours,
  type CampaignLeadFilter,
  type MembershipRole,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { getTelephonySettings, isDnc } from './accounts';
import { isWithinCallingHours, validateCallingHours } from './calling-hours';
import { clickToCall } from './service';
import { TelephonyError } from './types';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** How long an agent holds a claimed lead before it goes back to the queue. */
export const LOCK_MINUTES = 10;

export type CampaignInput = {
  name: string;
  mode: 'preview' | 'progressive';
  leadFilter: CampaignLeadFilter;
  agentIds: string[];
  callingHours: CallingHours;
  maxAttempts: number;
  retryGapMinutes: number;
};

export function validateCampaignInput(i: CampaignInput): string | null {
  if (!i.name.trim()) return 'Name is required.';
  if (!['preview', 'progressive'].includes(i.mode)) return 'Mode must be preview or progressive.';
  if (i.agentIds.length === 0) return 'Pick at least one agent.';
  if (i.maxAttempts < 1 || i.maxAttempts > 20) return 'Max attempts must be 1–20.';
  if (i.retryGapMinutes < 0) return 'Retry gap cannot be negative.';
  return validateCallingHours(i.callingHours);
}

/** Leads (deals) matching a campaign filter that have a callable contact phone. */
function filterSql(tenantId: string, f: CampaignLeadFilter) {
  const parts = [sql`d.tenant_id = ${tenantId}`, sql`d.deleted_at is null`, sql`c.phone_normalized is not null`];
  if (f.dealIds?.length) parts.push(sql`d.id in (${sql.join(f.dealIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (f.stages?.length) parts.push(sql`d.stage::text in (${sql.join(f.stages.map((s) => sql`${s}`), sql`, `)})`);
  if (f.ownerIds?.length) parts.push(sql`d.owner_id in (${sql.join(f.ownerIds.map((s) => sql`${s}`), sql`, `)})`);
  if (f.leadSourceIds?.length) parts.push(sql`d.lead_source_id in (${sql.join(f.leadSourceIds.map((s) => sql`${s}::uuid`), sql`, `)})`);
  if (f.createdAfter) parts.push(sql`d.created_at >= ${f.createdAfter}::timestamptz`);
  if (f.createdBefore) parts.push(sql`d.created_at < ${f.createdBefore}::timestamptz`);
  return sql.join(parts, sql` and `);
}

export async function createCampaign(args: { tenantId: string; userId: string; input: CampaignInput }): Promise<CallCampaign> {
  const err = validateCampaignInput(args.input);
  if (err) throw new TelephonyError(err, 'not_configured');
  return await tenantTransaction(async (tx) => {
    const [c] = await tx
      .insert(callCampaigns)
      .values({ tenantId: args.tenantId, ...args.input, createdBy: args.userId })
      .returning();
    await populateItems(tx, c!);
    return c!;
  });
}

/** Add every matching lead not already in the campaign. DNC numbers are skipped up front. */
export async function populateItems(tx: DrizzleTx, c: CallCampaign): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    with ins as (
      insert into call_campaign_items (campaign_id, tenant_id, lead_id, state, skip_reason)
      select ${c.id}::uuid, ${c.tenantId}::uuid, d.id,
             case when dn.phone_normalized is not null then 'skipped' else 'pending' end,
             case when dn.phone_normalized is not null then 'dnc' else null end
      from deals d
      join contacts c on c.id = d.contact_id
      left join dnc_numbers dn on dn.tenant_id = d.tenant_id and dn.phone_normalized = c.phone_normalized
      where ${filterSql(c.tenantId, c.leadFilter ?? {})}
      on conflict (campaign_id, lead_id) do nothing
      returning 1
    ) select count(*)::int as n from ins`);
  return Number(rows[0]?.n ?? 0);
}

export async function setCampaignStatus(tenantId: string, campaignId: string, status: 'running' | 'paused' | 'completed') {
  return await tenantTransaction(async (tx) => {
    const [c] = await tx
      .update(callCampaigns)
      .set({ status })
      .where(and(eq(callCampaigns.id, campaignId), eq(callCampaigns.tenantId, tenantId)))
      .returning();
    if (c && status === 'paused') {
      await tx
        .update(callCampaignItems)
        .set({ state: 'pending', lockedBy: null, lockedUntil: null })
        .where(and(eq(callCampaignItems.campaignId, campaignId), eq(callCampaignItems.state, 'locked')));
    }
    return c ?? null;
  });
}

/** Release claims whose lock expired (agent closed the tab, crashed …). */
export async function releaseStaleLocks(tx: DrizzleTx, tenantId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update call_campaign_items set state = 'pending', locked_by = null, locked_until = null, updated_at = now()
    where tenant_id = ${tenantId} and state = 'locked' and locked_until < now()
    returning id`);
  return rows.length;
}

export type NextItem = {
  item: CallCampaignItem;
  lead: { id: string; name: string; company: string | null; contactName: string | null; phone: string | null; stage: string; ownerId: string | null };
} | null;

/**
 * Atomically claim the next callable lead for this agent. Two agents can never
 * claim the same item: the inner SELECT … FOR UPDATE SKIP LOCKED makes a
 * concurrent claimer skip rows another transaction is taking. An agent who
 * already holds a claim gets that item back instead of a second one.
 */
export async function claimNextItem(args: { tenantId: string; campaignId: string; agentUserId: string; now?: Date }): Promise<NextItem> {
  const { tenantId, campaignId, agentUserId } = args;
  return await tenantTransaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(callCampaigns)
      .where(and(eq(callCampaigns.id, campaignId), eq(callCampaigns.tenantId, tenantId)));
    if (!campaign) throw new TelephonyError('Campaign not found.', 'not_found');
    if (campaign.status !== 'running') throw new TelephonyError('This campaign is not running.', 'not_configured');
    if (!campaign.agentIds.includes(agentUserId)) throw new TelephonyError('You are not an agent on this campaign.', 'not_owner');
    if (!isWithinCallingHours(campaign.callingHours, args.now)) {
      throw new TelephonyError(`Outside this campaign's calling hours (${campaign.callingHours.start}–${campaign.callingHours.end}).`, 'outside_hours');
    }
    const settings = await getTelephonySettings(tx, tenantId);

    // Serialise one agent's claims on this campaign (double-click, two tabs).
    // Without it, concurrent calls all miss each other's uncommitted lock in
    // the "already holding?" check below and each claims a new item.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${campaignId} || ':' || ${agentUserId}))`);

    const [held] = await tx
      .select()
      .from(callCampaignItems)
      .where(and(eq(callCampaignItems.campaignId, campaignId), eq(callCampaignItems.state, 'locked'), eq(callCampaignItems.lockedBy, agentUserId)))
      .limit(1);
    let item: CallCampaignItem | undefined = held;

    for (let guard = 0; !item && guard < 25; guard++) {
      const claimed = await tx.execute<Record<string, unknown>>(sql`
        update call_campaign_items set state = 'locked', locked_by = ${agentUserId},
          locked_until = now() + make_interval(mins => ${LOCK_MINUTES}), updated_at = now()
        where id = (
          select id from call_campaign_items
          where campaign_id = ${campaignId} and state = 'pending'
            and (next_attempt_at is null or next_attempt_at <= now())
            and attempts < ${campaign.maxAttempts}
          order by next_attempt_at nulls first, id
          for update skip locked
          limit 1
        )
        returning id`);
      const id = claimed[0]?.id as string | undefined;
      if (!id) return null;
      const [it] = await tx.select().from(callCampaignItems).where(eq(callCampaignItems.id, id));
      // DNC can be added mid-campaign: re-check at claim time.
      const [phone] = await tx.execute<{ p: string | null }>(sql`
        select c.phone_normalized as p from deals d left join contacts c on c.id = d.contact_id where d.id = ${it!.leadId}`);
      if (settings.enforceDnc && (await isDnc(tx, tenantId, phone?.p ?? null))) {
        await tx.update(callCampaignItems).set({ state: 'skipped', skipReason: 'dnc', lockedBy: null, lockedUntil: null }).where(eq(callCampaignItems.id, id));
        continue;
      }
      item = it;
    }
    if (!item) return null;

    const [lead] = await tx.execute<{ id: string; name: string; company: string | null; contact_name: string | null; phone: string | null; stage: string; owner_id: string | null }>(sql`
      select d.id, d.name, d.company_name as company,
             coalesce(nullif(trim(concat_ws(' ', c.first_name, c.last_name)), ''), d.contact_name) as contact_name,
             c.phone, d.stage::text as stage, d.owner_id
      from deals d left join contacts c on c.id = d.contact_id where d.id = ${item.leadId}`);
    return {
      item,
      lead: {
        id: lead!.id,
        name: lead!.name,
        company: lead!.company,
        contactName: lead!.contact_name,
        phone: lead!.phone,
        stage: lead!.stage,
        ownerId: lead!.owner_id,
      },
    };
  });
}

/** Dial the claimed item. Counts the attempt before dialing. */
export async function dialClaimedItem(args: { tenantId: string; userId: string; role: MembershipRole; itemId: string }) {
  const item = await tenantTransaction(async (tx) => {
    const [it] = await tx
      .update(callCampaignItems)
      .set({ attempts: sql`${callCampaignItems.attempts} + 1`, lockedUntil: sql`now() + make_interval(mins => ${LOCK_MINUTES})`, updatedAt: new Date() })
      .where(and(eq(callCampaignItems.id, args.itemId), eq(callCampaignItems.tenantId, args.tenantId), eq(callCampaignItems.state, 'locked'), eq(callCampaignItems.lockedBy, args.userId)))
      .returning();
    return it ?? null;
  });
  if (!item) throw new TelephonyError('This lead is no longer assigned to you. Pull the next one.', 'not_found');
  const { callId } = await clickToCall({
    tenantId: args.tenantId,
    userId: args.userId,
    role: args.role,
    leadId: item.leadId,
    fromCampaign: true,
    campaignId: item.campaignId,
    campaignItemId: item.id,
  });
  await tenantTransaction((tx) => tx.update(callCampaignItems).set({ lastCallId: callId }).where(eq(callCampaignItems.id, item.id)));
  return { callId };
}

export async function skipClaimedItem(args: { tenantId: string; userId: string; itemId: string; reason: string | null }) {
  await tenantTransaction((tx) =>
    tx
      .update(callCampaignItems)
      .set({ state: 'skipped', skipReason: args.reason ?? 'skipped by agent', lockedBy: null, lockedUntil: null, updatedAt: new Date() })
      .where(and(eq(callCampaignItems.id, args.itemId), eq(callCampaignItems.tenantId, args.tenantId), eq(callCampaignItems.lockedBy, args.userId))),
  );
}

export type CampaignBoard = {
  campaign: CallCampaign;
  counts: { pending: number; locked: number; done: number; skipped: number; total: number };
  callsMade: number;
  connected: number;
  connectRate: number | null;
  agents: Array<{ userId: string; status: string; holding: number; callsToday: number }>;
};

export async function getCampaignBoard(tenantId: string, campaignId: string): Promise<CampaignBoard | null> {
  return await tenantTransaction(async (tx) => {
    const [campaign] = await tx.select().from(callCampaigns).where(and(eq(callCampaigns.id, campaignId), eq(callCampaigns.tenantId, tenantId)));
    if (!campaign) return null;
    const stateRows = await tx
      .select({ state: callCampaignItems.state, n: sql<number>`count(*)::int` })
      .from(callCampaignItems)
      .where(eq(callCampaignItems.campaignId, campaignId))
      .groupBy(callCampaignItems.state);
    const counts = { pending: 0, locked: 0, done: 0, skipped: 0, total: 0 };
    for (const r of stateRows) {
      counts[r.state] = Number(r.n);
      counts.total += Number(r.n);
    }
    const [cs] = await tx
      .select({
        made: sql<number>`count(*)::int`,
        connected: sql<number>`count(*) filter (where ${calls.answeredAt} is not null or coalesce(${calls.talkTimeSec}, 0) > 0)::int`,
      })
      .from(calls)
      .where(and(eq(calls.tenantId, tenantId), eq(calls.campaignId, campaignId)));
    const mappings = campaign.agentIds.length
      ? await tx
          .select({ userId: userPhoneMapping.userId, status: userPhoneMapping.agentStatus })
          .from(userPhoneMapping)
          .where(and(eq(userPhoneMapping.tenantId, tenantId), inArray(userPhoneMapping.userId, campaign.agentIds)))
      : [];
    const holding = await tx
      .select({ userId: callCampaignItems.lockedBy, n: sql<number>`count(*)::int` })
      .from(callCampaignItems)
      .where(and(eq(callCampaignItems.campaignId, campaignId), eq(callCampaignItems.state, 'locked')))
      .groupBy(callCampaignItems.lockedBy);
    const today = await tx
      .select({ userId: calls.userId, n: sql<number>`count(*)::int` })
      .from(calls)
      .where(and(eq(calls.tenantId, tenantId), eq(calls.campaignId, campaignId), sql`${calls.createdAt} >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`))
      .groupBy(calls.userId);
    const made = Number(cs?.made ?? 0);
    const connected = Number(cs?.connected ?? 0);
    return {
      campaign,
      counts,
      callsMade: made,
      connected,
      connectRate: made ? connected / made : null,
      agents: campaign.agentIds.map((u) => ({
        userId: u,
        status: mappings.find((m) => m.userId === u)?.status ?? 'offline',
        holding: Number(holding.find((h) => h.userId === u)?.n ?? 0),
        callsToday: Number(today.find((t) => t.userId === u)?.n ?? 0),
      })),
    };
  });
}

/**
 * One dialer tick for a tenant: release stale claims, and mark running
 * campaigns with nothing left to call as completed. Unanswered calls are
 * re-queued with their retry gap when the call ends (service.ts), and DNC is
 * re-checked at claim time, so the tick stays small.
 */
export async function runDialerTick(tenantId: string): Promise<{ released: number; completed: number }> {
  return await tenantTransaction(async (tx) => {
    const released = await releaseStaleLocks(tx, tenantId);
    const done = await tx.execute<{ id: string }>(sql`
      update call_campaigns c set status = 'completed', updated_at = now()
      where c.tenant_id = ${tenantId} and c.status = 'running'
        and not exists (
          select 1 from call_campaign_items i
          where i.campaign_id = c.id and (i.state = 'locked' or (i.state = 'pending' and i.attempts < c.max_attempts))
        )
      returning c.id`);
    return { released, completed: done.length };
  });
}
