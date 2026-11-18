import 'server-only';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  contacts,
  deals,
  distributionRules,
  distributionState,
  leadAssignments,
  leadSources,
  memberships,
  userRoutingProfile,
  type DistributionRule,
  type WorkingHours,
} from '@/db/schema';
import { recordActivity } from '@/lib/activity/recorder';
import { tenantTransaction } from '@/lib/db-context';
import { logger } from '@/lib/observability';

import { ruleMatches, type LeadFacts } from './conditions';
import { runStrategy, type Candidate } from './strategies';
import { addWorkingMinutes, isWithinWorkingHours, nextWorkingStart } from './working-hours';

/**
 * Lead distribution engine.
 *
 * `planDistribution` is the single decision function. It is used both by
 * the real assignment (inside a transaction that holds the rotation row
 * lock) and by the simulate endpoint (dry run, no lock, no writes). That's
 * why a simulation matches the real assignment for the same input and state.
 *
 * Rule selection: active non-default rules by priority (lower first), first
 * whose conditions all match. If none match, the lead source's default rule,
 * then the tenant default rule. If none apply, the lead goes to the unassigned
 * queue.
 *
 * Eligibility, checked BEFORE the strategy runs: active member of the
 * workspace (not a viewer), in the rule's pool, not excluded (previous owners
 * on an SLA reassignment), `is_available`, inside working hours when the rule
 * respects availability, and under `capacity_cap` untouched open leads.
 */

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | DrizzleTx;

const LOAD_WINDOW_DAYS = 7;
const ROUTABLE_ROLES = ['owner', 'admin', 'manager', 'member'] as const;

export type LeadContext = {
  dealId: string | null;
  facts: LeadFacts;
  lead: { productInterest: string | null; city: string | null; state: string | null };
  sourceId: string | null;
};

export type EligibilityRow = {
  userId: string;
  eligible: boolean;
  /** Why not eligible: 'not_member' | 'excluded' | 'unavailable' | 'off_hours' | 'at_capacity'. */
  blockedBy: string | null;
  load: number;
  untouchedOpen: number;
};

export type DistributionPlan =
  | {
      kind: 'assign';
      rule: DistributionRule;
      userId: string;
      reason: string;
      eligibility: EligibilityRow[];
      nextLastUserId: string | null;
      nextWeightsState: Record<string, number>;
      workingHours: WorkingHours | null;
    }
  | {
      kind: 'unassigned' | 'queued';
      rule: DistributionRule | null;
      reason: string;
      eligibility: EligibilityRow[];
      /** For 'queued': the earliest time a pool member comes on shift. */
      retryAt: Date | null;
    };

/** Lead facts for rule conditions, from the deal + its contact + its source. */
export async function loadLeadContext(tx: Executor, dealId: string): Promise<LeadContext | null> {
  const [row] = await tx
    .select({
      id: deals.id,
      name: deals.name,
      source: deals.source,
      sourceId: deals.leadSourceId,
      city: deals.leadCity,
      state: deals.leadState,
      productInterest: deals.leadProductInterest,
      company: deals.companyNameText,
      utmSource: deals.utmSource,
      utmMedium: deals.utmMedium,
      utmCampaign: deals.utmCampaign,
      customFields: deals.customFields,
      amountMinor: deals.amountMinor,
      contactEmail: contacts.emailNormalized,
      contactPhone: contacts.phoneNormalized,
      sourceType: leadSources.type,
      sourceName: leadSources.name,
    })
    .from(deals)
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .leftJoin(leadSources, eq(leadSources.id, deals.leadSourceId))
    .where(eq(deals.id, dealId))
    .limit(1);
  if (!row) return null;
  return {
    dealId: row.id,
    sourceId: row.sourceId,
    lead: { productInterest: row.productInterest, city: row.city, state: row.state },
    facts: buildFacts({
      sourceId: row.sourceId,
      sourceType: row.sourceType,
      sourceName: row.sourceName ?? row.source,
      city: row.city,
      state: row.state,
      productInterest: row.productInterest,
      company: row.company,
      email: row.contactEmail,
      phone: row.contactPhone,
      utmSource: row.utmSource,
      utmMedium: row.utmMedium,
      utmCampaign: row.utmCampaign,
      amountMinor: row.amountMinor,
      customFields: row.customFields,
    }),
  };
}

export function buildFacts(f: {
  sourceId?: string | null;
  sourceType?: string | null;
  sourceName?: string | null;
  city?: string | null;
  state?: string | null;
  productInterest?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  amountMinor?: number | null;
  customFields?: Record<string, unknown> | null;
}): LeadFacts {
  const facts: LeadFacts = {
    source_id: f.sourceId ?? null,
    source_type: f.sourceType ?? null,
    source_name: f.sourceName ?? null,
    city: f.city ?? null,
    state: f.state ?? null,
    product_interest: f.productInterest ?? null,
    company: f.company ?? null,
    email_domain: f.email?.split('@')[1] ?? null,
    has_phone: !!f.phone,
    utm_source: f.utmSource ?? null,
    utm_medium: f.utmMedium ?? null,
    utm_campaign: f.utmCampaign ?? null,
    amount: f.amountMinor != null ? f.amountMinor / 100 : null,
  };
  for (const [k, v] of Object.entries(f.customFields ?? {})) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      facts[`custom.${k}`] = v as string | number | boolean | null;
    }
  }
  return facts;
}

async function selectRule(
  tx: Executor,
  tenantId: string,
  ctx: LeadContext,
): Promise<DistributionRule | null> {
  const rules = await tx
    .select()
    .from(distributionRules)
    .where(and(eq(distributionRules.tenantId, tenantId), eq(distributionRules.isActive, true)))
    .orderBy(asc(distributionRules.priority), asc(distributionRules.createdAt));

  const matched = rules.find((r) => !r.isDefault && ruleMatches(r.conditions ?? [], ctx.facts));
  if (matched) return matched;

  if (ctx.sourceId) {
    const [src] = await tx
      .select({ defaultRuleId: leadSources.defaultRuleId })
      .from(leadSources)
      .where(and(eq(leadSources.id, ctx.sourceId), eq(leadSources.tenantId, tenantId)))
      .limit(1);
    const sourceDefault = src?.defaultRuleId ? rules.find((r) => r.id === src.defaultRuleId) : undefined;
    if (sourceDefault) return sourceDefault;
  }
  return rules.find((r) => r.isDefault) ?? null;
}

/** Per-user open-lead counts: load (7-day open) and untouched (for capacity). */
async function loadCounts(
  tx: Executor,
  tenantId: string,
  userIds: string[],
): Promise<Map<string, { load: number; untouched: number }>> {
  const out = new Map<string, { load: number; untouched: number }>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select({
      userId: leadAssignments.assignedTo,
      load: sql<number>`count(*) filter (where ${leadAssignments.assignedAt} > now() - make_interval(days => ${LOAD_WINDOW_DAYS}))::int`,
      untouched: sql<number>`count(*) filter (where ${leadAssignments.firstTouchAt} is null)::int`,
    })
    .from(leadAssignments)
    .where(
      and(
        eq(leadAssignments.tenantId, tenantId),
        inArray(leadAssignments.assignedTo, userIds),
        isNull(leadAssignments.releasedAt),
      ),
    )
    .groupBy(leadAssignments.assignedTo);
  for (const r of rows) out.set(r.userId, { load: Number(r.load), untouched: Number(r.untouched) });
  return out;
}

export async function planDistribution(
  tx: Executor,
  args: {
    tenantId: string;
    ctx: LeadContext;
    excludeUserIds?: string[];
    now?: Date;
    /** Real assignment: lock the rotation row (SELECT … FOR UPDATE). */
    lockState: boolean;
  },
): Promise<DistributionPlan> {
  const { tenantId, ctx } = args;
  const now = args.now ?? new Date();
  const exclude = new Set(args.excludeUserIds ?? []);

  const rule = await selectRule(tx, tenantId, ctx);
  if (!rule) {
    return { kind: 'unassigned', rule: null, reason: 'no distribution rule matched', eligibility: [], retryAt: null };
  }

  const pool = rule.pool ?? { user_ids: [] };
  const poolOrder = [
    ...new Set(
      rule.strategy === 'fixed_owner' && pool.fixed_owner_id
        ? [pool.fixed_owner_id, ...(pool.user_ids ?? [])]
        : (pool.user_ids ?? []),
    ),
  ];

  const [members, profiles, counts] = await Promise.all([
    poolOrder.length
      ? tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, tenantId),
              inArray(memberships.userId, poolOrder),
              eq(memberships.status, 'active'),
              inArray(memberships.role, [...ROUTABLE_ROLES]),
            ),
          )
      : Promise.resolve([] as Array<{ userId: string }>),
    poolOrder.length
      ? tx
          .select()
          .from(userRoutingProfile)
          .where(and(eq(userRoutingProfile.tenantId, tenantId), inArray(userRoutingProfile.userId, poolOrder)))
      : Promise.resolve([]),
    loadCounts(tx, tenantId, poolOrder),
  ]);
  const memberSet = new Set(members.map((m) => m.userId));
  const profileBy = new Map(profiles.map((p) => [p.userId, p]));

  const eligibility: EligibilityRow[] = [];
  const eligible: Candidate[] = [];
  const offHoursStarts: Date[] = [];
  for (const userId of poolOrder) {
    const profile = profileBy.get(userId);
    const c = counts.get(userId) ?? { load: 0, untouched: 0 };
    let blockedBy: string | null = null;
    if (!memberSet.has(userId)) blockedBy = 'not_member';
    else if (exclude.has(userId)) blockedBy = 'excluded';
    else if (profile && !profile.isAvailable) blockedBy = 'unavailable';
    else if (rule.respectAvailability && !isWithinWorkingHours(profile?.workingHours ?? null, now)) {
      blockedBy = 'off_hours';
      const next = nextWorkingStart(profile?.workingHours ?? null, now);
      if (next) offHoursStarts.push(next);
    } else if (rule.capacityCap != null && c.untouched >= rule.capacityCap) blockedBy = 'at_capacity';

    eligibility.push({ userId, eligible: blockedBy === null, blockedBy, load: c.load, untouchedOpen: c.untouched });
    if (blockedBy === null) {
      eligible.push({ userId, load: c.load, skills: profile?.skills ?? [], regions: profile?.regions ?? [] });
    }
  }

  let lastUserId: string | null = null;
  let weightsState: Record<string, number> = {};
  if (rule.strategy === 'round_robin' || rule.strategy === 'weighted') {
    if (args.lockState) {
      await tx
        .insert(distributionState)
        .values({ ruleId: rule.id, tenantId })
        .onConflictDoNothing({ target: distributionState.ruleId });
      const [state] = await tx
        .select()
        .from(distributionState)
        .where(eq(distributionState.ruleId, rule.id))
        .for('update');
      lastUserId = state?.lastUserId ?? null;
      weightsState = state?.weightsState ?? {};
    } else {
      const [state] = await tx.select().from(distributionState).where(eq(distributionState.ruleId, rule.id));
      lastUserId = state?.lastUserId ?? null;
      weightsState = state?.weightsState ?? {};
    }
  }

  const result = runStrategy({
    strategy: rule.strategy,
    poolOrder,
    eligible,
    lastUserId,
    weights: pool.weights,
    weightsState,
    fixedOwnerId: pool.fixed_owner_id,
    lead: ctx.lead,
  });

  if (result.userId) {
    return {
      kind: 'assign',
      rule,
      userId: result.userId,
      reason: `${rule.name}: ${result.reason}`,
      eligibility,
      nextLastUserId: result.nextLastUserId,
      nextWeightsState: result.nextWeightsState,
      workingHours: profileBy.get(result.userId)?.workingHours ?? null,
    };
  }

  // Nobody eligible right now. If at least one pool member is blocked only by
  // working hours, the lead waits for the next shift instead of going to a
  // rep who is offline.
  if (eligible.length === 0 && offHoursStarts.length > 0) {
    const retryAt = new Date(Math.min(...offHoursStarts.map((d) => d.getTime())));
    return { kind: 'queued', rule, reason: `${rule.name}: everyone eligible is off shift`, eligibility, retryAt };
  }
  return { kind: 'unassigned', rule, reason: `${rule.name}: ${result.reason}`, eligibility, retryAt: null };
}

export type DistributeOutcome =
  | { status: 'assigned'; dealId: string; userId: string; assignmentId: string; ruleId: string; reason: string; slaDueAt: Date }
  | { status: 'unassigned' | 'queued'; dealId: string; reason: string; retryAt: Date | null }
  | { status: 'skipped'; dealId: string; reason: string };

/**
 * Assign one lead. Must run inside a tenant/system context. Locks the deal
 * row (so two workers can't both assign it) and the rule's rotation row (so
 * two leads can't both take the same round-robin slot).
 */
export async function distributeLead(args: {
  tenantId: string;
  dealId: string;
  excludeUserIds?: string[];
  /** 'rule:<id>' is filled in from the plan; pass 'system:sla' etc. to override. */
  assignedBy?: string;
  now?: Date;
}): Promise<DistributeOutcome> {
  const { tenantId, dealId } = args;
  return await tenantTransaction(async (tx) => {
    const [deal] = await tx
      .select({ id: deals.id, name: deals.name, stage: deals.stage, deletedAt: deals.deletedAt, ownerId: deals.ownerId, routingQueuedAt: deals.routingQueuedAt })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)))
      .for('update');
    if (!deal) return { status: 'skipped', dealId, reason: 'lead not found' } as const;
    if (deal.deletedAt) return { status: 'skipped', dealId, reason: 'lead deleted' } as const;
    if (deal.stage !== 'lead') return { status: 'skipped', dealId, reason: `stage is ${deal.stage}` } as const;

    const [open] = await tx
      .select({ id: leadAssignments.id })
      .from(leadAssignments)
      .where(and(eq(leadAssignments.dealId, dealId), isNull(leadAssignments.releasedAt)))
      .limit(1);
    if (open) return { status: 'skipped', dealId, reason: 'already assigned' } as const;

    const ctx = await loadLeadContext(tx, dealId);
    if (!ctx) return { status: 'skipped', dealId, reason: 'lead not found' } as const;

    const now = args.now ?? new Date();
    const plan = await planDistribution(tx, {
      tenantId,
      ctx,
      excludeUserIds: args.excludeUserIds,
      now,
      lockState: true,
    });

    if (plan.kind !== 'assign') {
      await tx
        .update(deals)
        .set({ routingStatus: 'unassigned', routingQueuedAt: deal.routingQueuedAt ?? now })
        .where(eq(deals.id, dealId));
      return { status: plan.kind, dealId, reason: plan.reason, retryAt: plan.retryAt } as const;
    }

    if (plan.rule.strategy === 'round_robin' || plan.rule.strategy === 'weighted') {
      await tx
        .update(distributionState)
        .set({ lastUserId: plan.nextLastUserId, weightsState: plan.nextWeightsState, updatedAt: now })
        .where(eq(distributionState.ruleId, plan.rule.id));
    }

    const slaDueAt = addWorkingMinutes(now, plan.rule.slaMinutes, plan.workingHours);
    const [assignment] = await tx
      .insert(leadAssignments)
      .values({
        tenantId,
        dealId,
        assignedTo: plan.userId,
        assignedBy: args.assignedBy ?? `rule:${plan.rule.id}`,
        ruleId: plan.rule.id,
        reason: plan.reason,
        assignedAt: now,
        slaDueAt,
      })
      .returning({ id: leadAssignments.id });

    await tx
      .update(deals)
      .set({ ownerId: plan.userId, routingStatus: 'assigned', routingQueuedAt: null, updatedBy: 'system' })
      .where(eq(deals.id, dealId));
    // Keep the contact's owner in step when it has none.
    await tx.execute(sql`
      update contacts set owner_id = ${plan.userId}
      where id = (select contact_id from deals where id = ${dealId}) and owner_id is null`);

    await recordActivity(tx, {
      tenantId,
      actorUserId: null,
      entityType: 'deal',
      entityId: dealId,
      action: 'owner_changed',
      metadata: {
        name: deal.name,
        from: deal.ownerId ?? null,
        to: plan.userId,
        reason: plan.reason,
        ruleId: plan.rule.id,
        assignedBy: args.assignedBy ?? `rule:${plan.rule.id}`,
        slaDueAt: slaDueAt.toISOString(),
      },
    });

    logger.info('lead assigned', { tenantId, dealId, ruleId: plan.rule.id, assignmentId: assignment!.id });
    return {
      status: 'assigned',
      dealId,
      userId: plan.userId,
      assignmentId: assignment!.id,
      ruleId: plan.rule.id,
      reason: plan.reason,
      slaDueAt,
    } as const;
  });
}

/**
 * Dry run for the Settings > Distribution "Simulate" panel: which rule
 * matches a sample lead and who would get it right now. No writes, no lock.
 */
export async function simulateDistribution(args: {
  tenantId: string;
  sample: {
    sourceId?: string | null;
    city?: string | null;
    state?: string | null;
    productInterest?: string | null;
    company?: string | null;
    email?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    customFields?: Record<string, unknown>;
  };
  now?: Date;
}): Promise<DistributionPlan> {
  return await tenantTransaction(async (tx) => {
    let sourceType: string | null = null;
    let sourceName: string | null = null;
    if (args.sample.sourceId) {
      const [s] = await tx
        .select({ type: leadSources.type, name: leadSources.name })
        .from(leadSources)
        .where(and(eq(leadSources.id, args.sample.sourceId), eq(leadSources.tenantId, args.tenantId)));
      sourceType = s?.type ?? null;
      sourceName = s?.name ?? null;
    }
    const s = args.sample;
    const ctx: LeadContext = {
      dealId: null,
      sourceId: s.sourceId ?? null,
      lead: { productInterest: s.productInterest ?? null, city: s.city ?? null, state: s.state ?? null },
      facts: buildFacts({ ...s, sourceType, sourceName, email: s.email?.toLowerCase() ?? null }),
    };
    return await planDistribution(tx, { tenantId: args.tenantId, ctx, now: args.now, lockState: false });
  });
}

/** Active owner/admin/manager user ids — recipients for queue + escalation alerts. */
export async function listLeadManagers(tenantId: string): Promise<string[]> {
  const rows = await tenantTransaction((tx) =>
    tx
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'active'),
          inArray(memberships.role, ['owner', 'admin', 'manager']),
        ),
      ),
  );
  return rows.map((r) => r.userId);
}

/** Every user this lead has ever been assigned to (SLA reassignment excludes them). */
export async function previousAssignees(tx: Executor, dealId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: leadAssignments.assignedTo })
    .from(leadAssignments)
    .where(eq(leadAssignments.dealId, dealId));
  return rows.map((r) => r.userId);
}

