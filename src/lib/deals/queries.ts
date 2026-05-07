import 'server-only';

import { and, desc, eq, ilike, isNotNull, isNull, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import { companies, contacts, deals, type Deal } from '@/db/schema';

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
