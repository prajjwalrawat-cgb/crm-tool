import 'server-only';

import { and, asc, desc, eq, ilike, isNotNull, isNull } from 'drizzle-orm';

import { companies, type Company } from '@/db/schema';
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';

export type CompanyOption = {
  id: string;
  name: string;
};

export async function listCompanyOptions(tenantId: string): Promise<CompanyOption[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), isNull(companies.deletedAt)))
      .orderBy(asc(companies.name)),
  );
}

export type ListCompaniesOptions = {
  search?: string;
};

/**
 * Active companies for a tenant. The explicit `WHERE tenant_id = ?` is
 * defense in depth — RLS already filters cross-tenant rows — and lets the
 * planner pick the (tenant_id, name) composite index. The `isNull(deletedAt)`
 * predicate is similarly redundant under the default RLS policy but kept
 * for the same reason.
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

  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(companies)
      .where(and(...conditions))
      .orderBy(desc(companies.createdAt)),
  );
}

export async function getCompanyById(
  tenantId: string,
  id: string,
): Promise<Company | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, tenantId),
          eq(companies.id, id),
          isNull(companies.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Soft-deleted companies. Surfaces only inside `withIncludeDeleted(...)`,
 * which sets the `app.include_deleted` GUC so the SELECT policy lets these
 * rows through.
 */
export async function listDeletedCompanies(tenantId: string): Promise<Company[]> {
  return await withIncludeDeleted(async () =>
    tenantTransaction(async (tx) =>
      tx
        .select()
        .from(companies)
        .where(
          and(eq(companies.tenantId, tenantId), isNotNull(companies.deletedAt)),
        )
        .orderBy(desc(companies.deletedAt)),
    ),
  );
}
