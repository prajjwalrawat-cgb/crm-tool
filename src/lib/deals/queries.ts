import 'server-only';

import { and, desc, eq, ilike, isNotNull, isNull, type SQL } from 'drizzle-orm';

import { companies, contacts, deals, type Deal } from '@/db/schema';
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';
import type { DealStage } from '@/lib/deals/schema';

export type DealRow = Deal & {
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
};

export type ListDealsOptions = {
  search?: string;
};

type RawJoinedRow = {
  id: string;
  tenantId: string;
  companyId: string | null;
  contactId: string | null;
  name: string;
  stage: DealStage;
  amountMinor: number;
  currency: string;
  expectedCloseDate: string | null;
  closedAt: Date | null;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedBy: string | null;
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
};

function shapeDealRow(r: RawJoinedRow): DealRow {
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

  const rows = await tenantTransaction(async (tx) =>
    tx
      .select(DEALS_PROJECTION)
      .from(deals)
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(desc(deals.createdAt)),
  );

  return rows.map(shapeDealRow);
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

export async function listDeletedDeals(tenantId: string): Promise<DealRow[]> {
  const rows = await withIncludeDeleted(async () =>
    tenantTransaction(async (tx) =>
      tx
        .select(DEALS_PROJECTION)
        .from(deals)
        .leftJoin(companies, eq(deals.companyId, companies.id))
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .where(and(eq(deals.tenantId, tenantId), isNotNull(deals.deletedAt)))
        .orderBy(desc(deals.deletedAt)),
    ),
  );
  return rows.map(shapeDealRow);
}

export type DealBoard = Record<DealStage, DealRow[]>;

export async function listDealsForBoard(tenantId: string): Promise<DealBoard> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select(DEALS_PROJECTION)
      .from(deals)
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(and(eq(deals.tenantId, tenantId), isNull(deals.deletedAt)))
      .orderBy(desc(deals.updatedAt)),
  );

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
    const bucket = grouped[row.stage];
    if (bucket) bucket.push(row);
  }
  return grouped;
}
