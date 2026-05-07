import 'server-only';

import { and, desc, eq, ilike, type SQL } from 'drizzle-orm';

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

/**
 * List deals for a tenant, joined with the linked company and contact (if
 * any). Search does a case-insensitive substring match on the deal name —
 * backed by the (tenant_id, stage) and (tenant_id) indexes from the schema
 * for the dominant filter dimensions; the name LIKE is acceptable because
 * each tenant's deal count stays small relative to the indexes already
 * narrowing the scan.
 */
export async function listDeals(
  tenantId: string,
  options: ListDealsOptions = {},
): Promise<DealRow[]> {
  const term = options.search?.trim();

  const conditions: SQL[] = [eq(deals.tenantId, tenantId)];
  if (term) {
    conditions.push(ilike(deals.name, `%${term}%`));
  }

  const rows = await db
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
      companyName: companies.name,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
    })
    .from(deals)
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(deals.createdAt));

  return rows.map((r) => {
    const { contactFirstName, contactLastName, contactEmail, ...rest } = r;
    const nameParts = [contactFirstName, contactLastName].filter(Boolean) as string[];
    return {
      ...rest,
      contactName: nameParts.length ? nameParts.join(' ') : null,
      contactEmail,
    };
  });
}
