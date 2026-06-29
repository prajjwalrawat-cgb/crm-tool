import 'server-only';

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { db } from '@/db';
import { companies, contacts, deals, type Deal } from '@/db/schema';
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';
import { type DealFilters } from '@/lib/deals/filters';
import { type DealStage } from '@/lib/deals/schema';

// Re-export so existing imports of `DealFilters` from this module keep
// working — but the canonical home for filter helpers is
// `@/lib/deals/filters` (client-safe; no `server-only` shackles).
export type { DealFilters } from '@/lib/deals/filters';

export type DealRow = Deal & {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export type DealOption = {
  id: string;
  label: string;
};

/**
 * Lightweight picker source for entity-linking dropdowns (e.g. "link
 * this task to a deal"). Returns active deals only, alphabetized by
 * name. Mirrors `listCompanyOptions` / `listContactOptions` shape.
 */
export async function listDealOptions(tenantId: string): Promise<DealOption[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({ id: deals.id, label: deals.name })
      .from(deals)
      .where(and(eq(deals.tenantId, tenantId), isNull(deals.deletedAt)))
      .orderBy(asc(deals.name)),
  );
}

export type ListDealsOptions = {
  search?: string;
  cursor?: Cursor | null;
  size?: PageSize;
  filters?: DealFilters;
  /** Required for `filters.mine` to resolve "owner == me". */
  currentUserId?: string;
  /**
   * Hard-restrict results to deals owned by this user OR unassigned.
   * Applied as a non-overridable WHERE clause so URL params can't
   * widen the scope. Used to enforce member visibility at SSR —
   * sales-persona pages set this; manager/admin pages leave it
   * undefined for full-team visibility.
   */
  restrictToOwnerOrUnassigned?: string;
};

type RawJoinedRow = {
  id: string;
  tenantId: string;
  companyId: string | null;
  contactId: string | null;
  name: string;
  description: string | null;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  expectedCloseDate: string | null;
  closedAt: Date | null;
  ownerId: string | null;
  probability: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
  companyNameText: string | null;
  contactNameText: string | null;
  contactEmailText: string | null;
  companyName: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
};

const DEALS_PROJECTION = {
  id: deals.id,
  tenantId: deals.tenantId,
  companyId: deals.companyId,
  contactId: deals.contactId,
  name: deals.name,
  description: deals.description,
  stage: deals.stage,
  amountMinor: deals.amountMinor,
  currency: deals.currency,
  expectedCloseDate: deals.expectedCloseDate,
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
  // Display name: the typed free-text label takes precedence, falling back
  // to the linked company record's name (legacy/linked deals).
  companyName: sql<string | null>`coalesce(${deals.companyNameText}, ${companies.name})`,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  // Free-text email wins, else the linked contact's email.
  contactEmail: sql<string | null>`coalesce(${deals.contactEmailText}, ${contacts.email})`,
};

/**
 * Match deals against the selected company NAMES. Company is free-text on
 * deals now, so the filter operates on names (see `listDealCompanyOptions`):
 * a deal matches if its free-text `company_name` equals one of the selected
 * names, OR it's a legacy/linked deal whose linked company name matches.
 */
function companyFilterCondition(tenantId: string, companyNames: string[]): SQL {
  const lowered = companyNames.map((n) => n.toLowerCase());
  const linkedIds = db
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.tenantId, tenantId),
        inArray(sql`lower(${companies.name})`, lowered),
      ),
    );
  return or(
    inArray(sql`lower(${deals.companyNameText})`, lowered),
    inArray(deals.companyId, linkedIds),
  )!;
}

/**
 * Company filter options for the deals page, sourced from the company names
 * actually used by deals (free-text `company_name`, plus any linked company's
 * name). Returns `{ id, name }` where `id === name` so the filter matches by
 * name. Deduped case-insensitively, alphabetized.
 */
export async function listDealCompanyOptions(
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .selectDistinct({
        name: sql<string>`coalesce(${deals.companyNameText}, ${companies.name})`,
      })
      .from(deals)
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .where(and(eq(deals.tenantId, tenantId), isNull(deals.deletedAt))),
  );
  const byLower = new Map<string, string>();
  for (const r of rows) {
    const name = (r.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, name);
  }
  return Array.from(byLower.values())
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }));
}

function shapeDealRow(r: RawJoinedRow): DealRow {
  const { contactFirstName, contactLastName, contactEmail, ...rest } = r;
  const nameParts = [contactFirstName, contactLastName].filter(Boolean) as string[];
  return {
    ...rest,
    contactName:
      r.contactNameText ?? (nameParts.length ? nameParts.join(' ') : null),
    contactEmail,
  };
}

export async function listDeals(
  tenantId: string,
  options: ListDealsOptions = {},
): Promise<Page<DealRow>> {
  const term = options.search?.trim();
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  const f = options.filters ?? {};

  const conditions: SQL[] = [
    eq(deals.tenantId, tenantId),
    isNull(deals.deletedAt),
  ];
  if (term) conditions.push(ilike(deals.name, `%${term}%`));

  // Apply filters. Each branch hits the matching index:
  //   stages          → (tenant_id, stage)
  //   amount range    → (tenant_id, ...) + amount_minor scan (cheap at our scale)
  //   close window    → (tenant_id, expected_close_date)
  //   stale           → updated_at predicate; covered by (tenant_id, deleted_at)
  //   companyId       → (tenant_id, company_id)
  if (f.stages && f.stages.length > 0) {
    conditions.push(inArray(deals.stage, f.stages));
  }
  if (typeof f.amountMinorMin === 'number') {
    conditions.push(gte(deals.amountMinor, f.amountMinorMin));
  }
  if (typeof f.amountMinorMax === 'number') {
    conditions.push(lte(deals.amountMinor, f.amountMinorMax));
  }
  if (f.expectedCloseFrom) {
    conditions.push(gte(deals.expectedCloseDate, f.expectedCloseFrom));
  }
  if (f.expectedCloseTo) {
    conditions.push(lte(deals.expectedCloseDate, f.expectedCloseTo));
  }
  if (f.stale) {
    const days = f.staleDays && f.staleDays > 0 ? f.staleDays : 14;
    conditions.push(
      sql`${deals.stage} NOT IN ('won','lost')`,
      sql`${deals.updatedAt} < NOW() - (${days}::int * INTERVAL '1 day')`,
    );
  }
  if (f.companyIds && f.companyIds.length > 0) {
    conditions.push(companyFilterCondition(tenantId, f.companyIds));
  }
  if (f.mine && options.currentUserId) {
    conditions.push(eq(deals.ownerId, options.currentUserId));
  }
  if (f.unassigned) {
    conditions.push(isNull(deals.ownerId));
  }
  if (f.ownerIds && f.ownerIds.length > 0) {
    conditions.push(inArray(deals.ownerId, f.ownerIds));
  }
  // Hard scope: members see only their deals + unassigned. URL params
  // cannot widen this — they're additive within the allowed set.
  if (options.restrictToOwnerOrUnassigned) {
    const me = options.restrictToOwnerOrUnassigned;
    const scoped = sql`(${deals.ownerId} = ${me} OR ${deals.ownerId} IS NULL)`;
    conditions.push(scoped);
  }

  if (options.cursor) {
    conditions.push(
      sql`(${deals.createdAt}, ${deals.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }

  return await timeQuery('deals.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select(DEALS_PROJECTION)
        .from(deals)
        .leftJoin(companies, eq(deals.companyId, companies.id))
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .where(and(...conditions))
        .orderBy(desc(deals.createdAt), desc(deals.id))
        .limit(size + 1),
    );
    const shaped = rows.map(shapeDealRow);
    return buildPage(shaped, size, (r) => ({
      ts: r.createdAt.toISOString(),
      id: r.id,
    }));
  });
}

export async function getDealById(
  tenantId: string,
  id: string,
): Promise<DealRow | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select(DEALS_PROJECTION)
      .from(deals)
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(
        and(
          eq(deals.tenantId, tenantId),
          eq(deals.id, id),
          isNull(deals.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows[0] ? shapeDealRow(rows[0]) : null;
}

export async function listDeletedDeals(
  tenantId: string,
  options: { cursor?: Cursor | null; size?: PageSize } = {},
): Promise<Page<DealRow>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  return await timeQuery('deals.deleted', async () =>
    withIncludeDeleted(async () =>
      tenantTransaction(async (tx) => {
        const conditions: SQL[] = [
          eq(deals.tenantId, tenantId),
          isNotNull(deals.deletedAt),
        ];
        if (options.cursor) {
          conditions.push(
            sql`(${deals.deletedAt}, ${deals.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
          );
        }
        const rows = await tx
          .select(DEALS_PROJECTION)
          .from(deals)
          .leftJoin(companies, eq(deals.companyId, companies.id))
          .leftJoin(contacts, eq(deals.contactId, contacts.id))
          .where(and(...conditions))
          .orderBy(desc(deals.deletedAt), desc(deals.id))
          .limit(size + 1);
        const shaped = rows.map(shapeDealRow);
        return buildPage(shaped, size, (r) => ({
          ts: (r.deletedAt ?? new Date(0)).toISOString(),
          id: r.id,
        }));
      }),
    ),
  );
}

/**
 * Per-stage row cap for the kanban board. Six columns × this many ≈
 * the upper bound of rows the board ever fetches in a single page
 * load. The user can drill into per-stage filters later if they need
 * more depth; the kanban itself isn't designed for hundreds of cards
 * per column without virtualization.
 */
export const BOARD_PER_STAGE_LIMIT = 50;

export type DealBoard = Record<DealStage, DealRow[]>;
export type DealBoardSummary = {
  board: DealBoard;
  /** Per-stage total count (after RLS) — surfaces "X+ more" in the UI. */
  counts: Record<DealStage, number>;
  /** True if any stage was capped. */
  capped: boolean;
};

/**
 * Board snapshot. Caps at BOARD_PER_STAGE_LIMIT rows per stage by
 * issuing one query per stage with a LIMIT, in parallel. Six small
 * queries hit the (tenant_id, stage) index cleanly and trade trivially
 * more round trips for an order-of-magnitude smaller result set than
 * the old "fetch everything, group in JS" pattern. A separate cheap
 * COUNT(*) GROUP BY stage powers the "X / Y in <stage>" badges.
 *
 * Filters apply the same conditions as `listDeals` so the user's
 * filter selection from the list view round-trips to the board view
 * (and vice-versa) — within each stage column we still cap at
 * BOARD_PER_STAGE_LIMIT. A `stages` filter narrows which columns get
 * populated; columns excluded by the filter are skipped entirely and
 * stay empty in the response.
 */
export async function listDealsForBoard(
  tenantId: string,
  options: {
    restrictToOwnerOrUnassigned?: string;
    filters?: DealFilters;
    /** Required for `filters.mine` to resolve "owner == me". */
    currentUserId?: string;
  } = {},
): Promise<DealBoardSummary> {
  const STAGES: DealStage[] = [
    'lead',
    'qualified',
    'proposal',
    'negotiation',
    'won',
    'lost',
  ];
  const f = options.filters ?? {};
  return await timeQuery('deals.board', async () => {
    return await tenantTransaction(async (tx) => {
      const board: DealBoard = {
        lead: [],
        qualified: [],
        proposal: [],
        negotiation: [],
        won: [],
        lost: [],
      };
      const counts: Record<DealStage, number> = {
        lead: 0,
        qualified: 0,
        proposal: 0,
        negotiation: 0,
        won: 0,
        lost: 0,
      };

      // Conditions shared between the per-stage SELECTs and the
      // totals GROUP BY. The `stage` filter is excluded here because
      // the per-stage queries already constrain by stage, and the
      // totals query needs to see the full breakdown (then the UI
      // hides stages the user didn't ask for).
      const sharedConds: SQL[] = [
        eq(deals.tenantId, tenantId),
        isNull(deals.deletedAt),
      ];
      if (typeof f.amountMinorMin === 'number') {
        sharedConds.push(gte(deals.amountMinor, f.amountMinorMin));
      }
      if (typeof f.amountMinorMax === 'number') {
        sharedConds.push(lte(deals.amountMinor, f.amountMinorMax));
      }
      if (f.expectedCloseFrom) {
        sharedConds.push(gte(deals.expectedCloseDate, f.expectedCloseFrom));
      }
      if (f.expectedCloseTo) {
        sharedConds.push(lte(deals.expectedCloseDate, f.expectedCloseTo));
      }
      if (f.stale) {
        const days = f.staleDays && f.staleDays > 0 ? f.staleDays : 14;
        sharedConds.push(
          sql`${deals.stage} NOT IN ('won','lost')`,
          sql`${deals.updatedAt} < NOW() - (${days}::int * INTERVAL '1 day')`,
        );
      }
      if (f.companyIds && f.companyIds.length > 0) {
        sharedConds.push(companyFilterCondition(tenantId, f.companyIds));
      }
      if (f.mine && options.currentUserId) {
        sharedConds.push(eq(deals.ownerId, options.currentUserId));
      }
      if (f.unassigned) {
        sharedConds.push(isNull(deals.ownerId));
      }
      if (f.ownerIds && f.ownerIds.length > 0) {
        sharedConds.push(inArray(deals.ownerId, f.ownerIds));
      }
      if (options.restrictToOwnerOrUnassigned) {
        const me = options.restrictToOwnerOrUnassigned;
        sharedConds.push(
          sql`(${deals.ownerId} = ${me} OR ${deals.ownerId} IS NULL)`,
        );
      }

      // If the user selected specific stages, skip the rest entirely
      // — keeps the round-trip count down and the empty columns at 0
      // counts so the board UI can hide them.
      const stagesToFetch =
        f.stages && f.stages.length > 0
          ? STAGES.filter((s) => f.stages!.includes(s))
          : STAGES;

      const stageResults = await Promise.all(
        stagesToFetch.map(async (stage) => {
          const rows = await tx
            .select(DEALS_PROJECTION)
            .from(deals)
            .leftJoin(companies, eq(deals.companyId, companies.id))
            .leftJoin(contacts, eq(deals.contactId, contacts.id))
            .where(and(...sharedConds, eq(deals.stage, stage)))
            .orderBy(desc(deals.updatedAt), desc(deals.id))
            .limit(BOARD_PER_STAGE_LIMIT);
          return { stage, rows: rows.map(shapeDealRow) };
        }),
      );
      for (const { stage, rows } of stageResults) {
        board[stage] = rows;
      }

      const totalsConds: SQL[] = [...sharedConds];
      if (f.stages && f.stages.length > 0) {
        totalsConds.push(inArray(deals.stage, f.stages));
      }
      const totals = await tx
        .select({
          stage: deals.stage,
          n: sql<number>`count(*)::int`,
        })
        .from(deals)
        .where(and(...totalsConds))
        .groupBy(deals.stage);
      for (const t of totals) {
        counts[t.stage as DealStage] = t.n;
      }

      const capped = STAGES.some((s) => counts[s] > board[s].length);
      return { board, counts, capped };
    });
  });
}
