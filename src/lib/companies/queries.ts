import 'server-only';

import { and, desc, eq, ilike } from 'drizzle-orm';

import { db } from '@/db';
import { companies, type Company } from '@/db/schema';

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
