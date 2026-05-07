import 'server-only';

import { and, asc, desc, eq, ilike } from 'drizzle-orm';

import { db } from '@/db';
import { companies, type Company } from '@/db/schema';

export type CompanyOption = {
  id: string;
  name: string;
};

/**
 * Lightweight (id, name) projection of a tenant's companies, sorted A-Z.
 * Use for picker UIs that don't need the full row.
 */
export async function listCompanyOptions(tenantId: string): Promise<CompanyOption[]> {
  return await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.tenantId, tenantId))
    .orderBy(asc(companies.name));
}

export type ListCompaniesOptions = {
  search?: string;
};

/**
 * List companies for a tenant, newest first. When `search` is provided we
 * do a case-insensitive prefix-anywhere match on `name` (LIKE %q%) — backed
 * by the (tenant_id, name) index, so it stays fast even on big tenants.
 */
export async function listCompanies(
  tenantId: string,
  options: ListCompaniesOptions = {},
): Promise<Company[]> {
  const term = options.search?.trim();

  const where = term
    ? and(eq(companies.tenantId, tenantId), ilike(companies.name, `%${term}%`))
    : eq(companies.tenantId, tenantId);

  return await db
    .select()
    .from(companies)
    .where(where)
    .orderBy(desc(companies.createdAt));
}
