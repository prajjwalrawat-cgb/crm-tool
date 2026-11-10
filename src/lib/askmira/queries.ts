import 'server-only';

// Reading for one person (query, use=query): what AskMiraa's assistant shows.
//
// Every answer is what that person sees in Saleinx itself: a rep (member) or
// viewer sees the deals they own and unassigned ones, as on the Deals page; a
// manager, admin or owner sees the whole workspace. Reads run inside the
// workspace's tenant context, so row level security holds as it does for a
// page. Each answer says what the person may do here (`actor`), so AskMiraa
// never offers them a change Saleinx would refuse.

import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { companies, contacts, deals, users } from '@/db/schema';
import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { HOLD_REASON_LABELS, HOLD_REASONS } from '@/lib/deals/hold';
import { DEAL_STAGE_LABELS, DEAL_STAGES } from '@/lib/deals/schema';
import {
  CLOSE_DATE_REQUIRED_STAGES,
  ROLLBACK_REASON_LABELS,
  ROLLBACK_REASONS,
} from '@/lib/deals/stage-governance';
import { MARGIN_OPTIONAL_STAGES } from '@/lib/deals/validation';
import { fromMinorUnits } from '@/lib/deals/currency';
import { isOfferingsEnabled, listOfferingOptions } from '@/lib/offerings/queries';
import { personaOf } from '@/lib/personas';
import { can } from '@/lib/rbac';

import { clean, httpError, UUID_RE, type Linked, type Person } from './core';

export type QueryArgs = { found: Linked; me: Person; params: Record<string, unknown> };

const LIMIT = 25;

/** What the person may do here: their role decides, as on every page. */
export function actorOf(me: Person) {
  return {
    name: me.name,
    role: me.role,
    persona: personaOf(me.role),
    can_manage_deals: can(me.role, 'manageDeals'),
    can_approve_deals: can(me.role, 'approveDeals'),
    sees: personaOf(me.role) === 'sales' ? 'own_and_unassigned' : 'workspace',
  };
}

function inScope<T>(me: Person, fn: () => Promise<T>) {
  return runWithTenantContext({ tenantId: me.tenantId, userId: me.userId }, fn);
}

/** A sales-persona person reads their own deals and unassigned ones only. */
function scopeOf(me: Person): SQL | undefined {
  if (personaOf(me.role) !== 'sales') return undefined;
  return or(eq(deals.ownerId, me.userId), isNull(deals.ownerId));
}

const COMPANY = sql<string | null>`coalesce(${companies.name}, ${deals.companyNameText})`;
const OWNER = sql<string | null>`nullif(trim(concat_ws(' ', ${users.firstName}, ${users.lastName})), '')`;
const CONTACT = sql<string | null>`coalesce(
  nullif(trim(concat_ws(' ', ${contacts.firstName}, ${contacts.lastName})), ''),
  ${deals.contactNameText}
)`;

const ROW = {
  id: deals.id,
  name: deals.name,
  company: COMPANY,
  contact: CONTACT,
  stage: deals.stage,
  amountMinor: deals.amountMinor,
  currency: deals.currency,
  marginBps: deals.marginBps,
  expectedCloseDate: deals.expectedCloseDate,
  approvalStatus: deals.approvalStatus,
  approvedAt: deals.approvedAt,
  ownerId: deals.ownerId,
  owner: OWNER,
  nextStep: deals.nextStep,
  source: deals.source,
  holdReason: deals.holdReason,
  holdRevisitOn: deals.holdRevisitOn,
  lostReason: deals.lostReason,
  closedAt: deals.closedAt,
  updatedAt: deals.updatedAt,
};

type Row = {
  id: string;
  name: string;
  company: string | null;
  contact: string | null;
  stage: string;
  amountMinor: number;
  currency: string;
  marginBps: number | null;
  expectedCloseDate: string | null;
  approvalStatus: string;
  approvedAt: Date | null;
  ownerId: string | null;
  owner: string | null;
  nextStep: string | null;
  source: string | null;
  holdReason: string | null;
  holdRevisitOn: string | null;
  lostReason: string | null;
  closedAt: Date | null;
  updatedAt: Date;
};

/** Money as a decimal string in major units (never a float on the wire). */
function money(minor: number, currency: string) {
  return fromMinorUnits(Number(minor), currency).toFixed(currency === 'JPY' ? 0 : 2);
}

export function shapeDeal(row: Row) {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    // "Company - Deal", as the board titles a card.
    title: row.company ? `${row.company} - ${row.name}` : row.name,
    contact: row.contact,
    stage: row.stage,
    stage_label: DEAL_STAGE_LABELS[row.stage as keyof typeof DEAL_STAGE_LABELS] ?? row.stage,
    amount: money(row.amountMinor, row.currency),
    currency: row.currency,
    margin_pct: row.marginBps == null ? null : (row.marginBps / 100).toFixed(2),
    expected_close_date: row.expectedCloseDate,
    approval_status: row.approvalStatus,
    approved_at: row.approvedAt?.toISOString() ?? null,
    owner: row.owner,
    next_step: row.nextStep,
    source: row.source,
    hold_reason: row.holdReason,
    hold_revisit_on: row.holdRevisitOn,
    lost_reason: row.lostReason,
    closed_at: row.closedAt?.toISOString() ?? null,
    updated_at: row.updatedAt.toISOString(),
  };
}

function base() {
  return (tx: Parameters<Parameters<typeof tenantTransaction>[0]>[0]) =>
    tx
      .select(ROW)
      .from(deals)
      .leftJoin(companies, eq(companies.id, deals.companyId))
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .leftJoin(users, eq(users.id, deals.ownerId));
}

/** Text to search for: LIKE's own wildcards taken literally. */
function pattern(value: unknown): string | null {
  const text = clean(value, 120);
  if (!text) return null;
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A deal matching what the person typed: its name, its company, or the two
 * together the way the board shows them ("TEST Orion Logistics - Fleet Portal",
 * with a hyphen or a dash).
 */
function matches(text: string): SQL {
  const words = text.replace(/[–—]/g, '-');
  return or(
    ilike(deals.name, words),
    ilike(COMPANY as unknown as typeof deals.name, words),
    sql`concat_ws(' - ', ${COMPANY}, ${deals.name}) ilike ${words}`,
  )!;
}

async function listDeals({ me, params }: QueryArgs) {
  const where: SQL[] = [eq(deals.tenantId, me.tenantId), isNull(deals.deletedAt)];
  const scope = scopeOf(me);
  if (scope) where.push(scope);
  const term = pattern(params.query);
  if (term) where.push(matches(term));
  const stages = (Array.isArray(params.stages) ? params.stages : [params.stage])
    .map((s) => String(s ?? '').toLowerCase())
    .filter((s): s is (typeof DEAL_STAGES)[number] => (DEAL_STAGES as readonly string[]).includes(s));
  if (stages.length) where.push(inArray(deals.stage, stages));
  if (params.mine === true) where.push(eq(deals.ownerId, me.userId));
  if (params.awaiting_approval === true) {
    where.push(eq(deals.stage, 'won'), eq(deals.approvalStatus, 'pending'));
  }
  const limit = Math.min(Math.max(Number(params.limit) || LIMIT, 1), 50);
  return await inScope(me, async () => {
    const rows = (await tenantTransaction((tx) =>
      base()(tx)
        .where(and(...where))
        .orderBy(desc(deals.updatedAt), desc(deals.id))
        .limit(limit),
    )) as Row[];
    const [{ total }] = (await tenantTransaction((tx) =>
      tx
        .select({ total: sql<number>`count(*)::int` })
        .from(deals)
        .leftJoin(companies, eq(companies.id, deals.companyId))
        .where(and(...where)),
    )) as [{ total: number }];
    return { total, deals: rows.map(shapeDeal) };
  });
}

/** One deal the person can see, or a 404 (the same answer as a deal that does not exist). */
export async function dealFor(me: Person, id: unknown) {
  const dealId = String(id ?? '');
  if (!UUID_RE.test(dealId)) throw httpError(422, 'Which deal? Its id is missing.');
  const where: SQL[] = [eq(deals.tenantId, me.tenantId), eq(deals.id, dealId), isNull(deals.deletedAt)];
  const scope = scopeOf(me);
  if (scope) where.push(scope);
  const [row] = (await inScope(me, () =>
    tenantTransaction((tx) => base()(tx).where(and(...where)).limit(1)),
  )) as Row[];
  if (!row) throw httpError(404, 'That deal is not one you can see in Saleinx.');
  return shapeDeal(row);
}

async function oneDeal({ me, params }: QueryArgs) {
  return { deal: await dealFor(me, params.id) };
}

async function approvals({ me }: QueryArgs) {
  if (!can(me.role, 'approveDeals')) {
    throw httpError(403, 'Approving won deals is for managers, admins and owners in Saleinx.');
  }
  return await inScope(me, async () => {
    const rows = (await tenantTransaction((tx) =>
      base()(tx)
        .where(
          and(
            eq(deals.tenantId, me.tenantId),
            isNull(deals.deletedAt),
            eq(deals.stage, 'won'),
            eq(deals.approvalStatus, 'pending'),
          ),
        )
        .orderBy(desc(deals.closedAt))
        .limit(50),
    )) as Row[];
    return { total: rows.length, deals: rows.map(shapeDeal) };
  });
}

async function overview({ me }: QueryArgs) {
  const where: SQL[] = [eq(deals.tenantId, me.tenantId), isNull(deals.deletedAt)];
  const scope = scopeOf(me);
  if (scope) where.push(scope);
  return await inScope(me, async () => {
    const rows = (await tenantTransaction((tx) =>
      tx
        .select({
          stage: deals.stage,
          currency: deals.currency,
          count: sql<number>`count(*)::int`,
          amountMinor: sql<string>`coalesce(sum(${deals.amountMinor}), 0)::text`,
        })
        .from(deals)
        .where(and(...where))
        .groupBy(deals.stage, deals.currency),
    )) as Array<{ stage: string; currency: string; count: number; amountMinor: string }>;
    return {
      stages: rows.map((r) => ({
        stage: r.stage,
        stage_label: DEAL_STAGE_LABELS[r.stage as keyof typeof DEAL_STAGE_LABELS] ?? r.stage,
        currency: r.currency,
        deals: r.count,
        amount: money(Number(r.amountMinor), r.currency),
      })),
    };
  });
}

/** The vocabulary a change needs, and the rules it will be checked against. */
async function options({ me }: QueryArgs) {
  return await inScope(me, async () => {
    const offeringsOn = await isOfferingsEnabled(me.tenantId);
    const offerings = offeringsOn ? await listOfferingOptions(me.tenantId) : [];
    return {
      stages: DEAL_STAGES.map((s) => ({ key: s, label: DEAL_STAGE_LABELS[s] })),
      hold_reasons: HOLD_REASONS.map((r) => ({ key: r, label: HOLD_REASON_LABELS[r] })),
      rollback_reasons: ROLLBACK_REASONS.map((r) => ({ key: r, label: ROLLBACK_REASON_LABELS[r] })),
      offerings_required: offeringsOn,
      offerings: offerings.map((o) => ({ id: o.id, name: o.name, category: o.category })),
      rules: {
        margin_optional_stages: [...MARGIN_OPTIONAL_STAGES],
        close_date_required_stages: [...CLOSE_DATE_REQUIRED_STAGES],
        lead_has_no_close_date: true,
        hold_needs_reason_and_revisit_date: true,
        member_won_needs_approval: true,
        // 0071 — the client's PO is attached in Saleinx, never through AskMiraa.
        won_needs_client_po_matching_value: true,
        create_at_won_refused: true,
      },
    };
  });
}

export const QUERIES: Record<string, (args: QueryArgs) => Promise<Record<string, unknown>>> = {
  deals: listDeals,
  deal: oneDeal,
  approvals,
  overview,
  options,
};
