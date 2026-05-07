import 'server-only';

import { and, asc, desc, eq, ilike, isNotNull, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { companies, type Company } from '@/db/schema';

export type CompanyOption = {
  id: string;
  name: string;
};

/**
 * Lightweight (id, name) projection of a tenant's *active* companies, A-Z.
 */
export async function listCompanyOptions(tenantId: string): Promise<CompanyOption[]> {
  return await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), isNull(companies.deletedAt)))
    .orderBy(asc(companies.name));
}

export type ListCompaniesOptions = {
  search?: string;
};

/**
 * List active companies for a tenant, newest first. Soft-deleted rows are
 * always excluded — the recently-deleted page uses listDeletedCompanies.
 */
export async function listCompanies(
  tenantId: string,
  options: ListCompaniesOptions = {},
): Promise<Company[]> {
  const term = options.search?.trim();
  const conditions = [
    eq(companies.tenantId, tenantId),
    isNull(companies.deletedAt),
  ];
  if (term) conditions.push(ilike(companies.name, `%${term}%`));

  return await db
    .select()
    .from(companies)
    .where(and(...conditions))
    .orderBy(desc(companies.createdAt));
}

/**
 * Single-record fetch, soft-delete-aware. Returns null if the row is missing,
 * deleted, or belongs to a different tenant — the same shape we want for an
 * edit drawer that's been opened with a stale id.
 */
export async function getCompanyById(
  tenantId: string,
  id: string,
): Promise<Company | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(
      and(
        eq(companies.tenantId, tenantId),
        eq(companies.id, id),
        isNull(companies.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Soft-deleted companies for the recently-deleted page. Newest deletions first.
 */
export async function listDeletedCompanies(tenantId: string): Promise<Company[]> {
  return await db
    .select()
    .from(companies)
    .where(
      and(eq(companies.tenantId, tenantId), isNotNull(companies.deletedAt)),
    )
    .orderBy(desc(companies.deletedAt));
}
