import 'server-only';

import { and, desc, eq, ilike, isNotNull, isNull, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import { companies, contacts, deals, type Deal } from '@/db/schema';
import type { DealStage } from '@/lib/deals/schema';

export type DealRow = Deal & {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export type ListDealsOptions = {
  search?: string;
};

function dealsSelect() {
  return db
    .select({
      id: deals.id,
      tenantId: deals.tenantId,
      companyId: deals.companyId,
      contactId: deals.contactId,
      name: deals.name,
      stage: deals.stage,
      amountMinor: deals.amountMinor,
      currency: deals.currency,
      expectedCloseDate: deals.expectedCloseDate,
      closedAt: deals.closedAt,
      ownerId: deals.ownerId,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
      deletedAt: deals.deletedAt,
      deletedBy: deals.deletedBy,
      companyName: companies.name,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
    })
    .from(deals)
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id));
}

type RawDealRow = Awaited<ReturnType<typeof dealsSelect>>[number];

function shapeDealRow(r: RawDealRow): DealRow {
  const { contactFirstName, contactLastName, contactEmail, ...rest } = r;
  const nameParts = [contactFirstName, contactLastName].filter(Boolean) as string[];
  return {
    ...rest,
    contactName: nameParts.length ? nameParts.join(' ') : null,
    contactEmail,
  };
}

export async function listDeals(
  tenantId: string,
  options: ListDealsOptions = {},
): Promise<DealRow[]> {
  const term = options.search?.trim();

  const conditions: SQL[] = [
    eq(deals.tenantId, tenantId),
    isNull(deals.deletedAt),
  ];
  if (term) conditions.push(ilike(deals.name, `%${term}%`));

  const rows = await dealsSelect()
    .where(and(...conditions))
    .orderBy(desc(deals.createdAt));

  return rows.map(shapeDealRow);
}

export async function getDealById(
  tenantId: string,
  id: string,
): Promise<DealRow | null> {
  const rows = await dealsSelect()
    .where(
      and(
        eq(deals.tenantId, tenantId),
        eq(deals.id, id),
        isNull(deals.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? shapeDealRow(row) : null;
}

export async function listDeletedDeals(tenantId: string): Promise<DealRow[]> {
  const rows = await dealsSelect()
    .where(and(eq(deals.tenantId, tenantId), isNotNull(deals.deletedAt)))
    .orderBy(desc(deals.deletedAt));
  return rows.map(shapeDealRow);
}

export type DealBoard = Record<DealStage, DealRow[]>;

/**
 * Single-query board fetch. Returns deals grouped by stage, ordered within
 * each column by `updated_at DESC` so a freshly-moved card lands at the top
 * of its new column on the next revalidation. One DB round-trip; the join +
 * grouping happens app-side off the same row set so there is no N+1 across
 * tens of stages × hundreds of cards.
 */
export async function listDealsForBoard(tenantId: string): Promise<DealBoard> {
  const rows = await dealsSelect()
    .where(and(eq(deals.tenantId, tenantId), isNull(deals.deletedAt)))
    .orderBy(desc(deals.updatedAt));

  const grouped: DealBoard = {
    lead: [],
    qualified: [],
    proposal: [],
    negotiation: [],
    won: [],
    lost: [],
  };
  for (const raw of rows) {
    const row = shapeDealRow(raw);
    const bucket = grouped[row.stage as DealStage];
    // Defense in depth: if a row's stage somehow falls outside our enum,
    // skip it rather than crashing the whole board.
    if (bucket) bucket.push(row);
  }

  return grouped;
}
