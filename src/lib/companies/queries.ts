import 'server-only';

import { and, asc, desc, eq, ilike, isNotNull, isNull, sql } from 'drizzle-orm';

import { companies, type Company } from '@/db/schema';
import { type CompanyFilters } from '@/lib/companies/filters';
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';

export type { CompanyFilters } from '@/lib/companies/filters';

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
  cursor?: Cursor | null;
  size?: PageSize;
  filters?: CompanyFilters;
  /** Required for `filters.mine` to resolve "owner == me". */
  currentUserId?: string;
};

/**
 * Active companies, paginated by `(created_at desc, id)` keyset. We
 * SELECT `size + 1` rows so the helper can detect "is there another
 * page" without a separate COUNT(*). The (tenant_id, deleted_at) and
 * (tenant_id, name) indexes from migration 0000 cover the predicate;
 * `created_at` falls back to a heap scan over the tenant slice, which
 * is acceptable at our cardinality (per-tenant, not global).
 */
export async function listCompanies(
  tenantId: string,
  options: ListCompaniesOptions = {},
): Promise<Page<Company>> {
  const term = options.search?.trim();
  const size = options.size ?? DEFAULT_PAGE_SIZE;

  const f = options.filters ?? {};
  const conditions = [
    eq(companies.tenantId, tenantId),
    isNull(companies.deletedAt),
  ];
  if (term) conditions.push(ilike(companies.name, `%${term}%`));

  // Filter predicates. Each subquery hits an existing index on the
  // corresponding table.
  if (f.hasDeals) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM deals d
      WHERE d.tenant_id = ${tenantId}::uuid
        AND d.company_id = ${companies.id}
        AND d.deleted_at IS NULL
        AND d.stage NOT IN ('won','lost')
    )`);
  }
  if (typeof f.recentActivityDays === 'number') {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM activity_logs al
      WHERE al.tenant_id = ${tenantId}::uuid
        AND al.entity_type = 'company'
        AND al.entity_id::uuid = ${companies.id}
        AND al.created_at >= NOW() - (${f.recentActivityDays}::int * INTERVAL '1 day')
    )`);
  }
  if (typeof f.createdWithinDays === 'number') {
    conditions.push(
      sql`${companies.createdAt} >= NOW() - (${f.createdWithinDays}::int * INTERVAL '1 day')`,
    );
  }
  if (f.stale) {
    const days = f.staleDays && f.staleDays > 0 ? f.staleDays : 30;
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM activity_logs al
      WHERE al.tenant_id = ${tenantId}::uuid
        AND al.entity_type = 'company'
        AND al.entity_id::uuid = ${companies.id}
        AND al.created_at >= NOW() - (${days}::int * INTERVAL '1 day')
    )`);
  }
  if (f.mine && options.currentUserId) {
    conditions.push(eq(companies.ownerId, options.currentUserId));
  }
  if (f.unassigned) {
    conditions.push(isNull(companies.ownerId));
  }

  if (options.cursor) {
    // Postgres tuple comparison is lexicographic, so this is the
    // canonical keyset forward-page predicate for desc-sorted ORDER BY.
    conditions.push(
      sql`(${companies.createdAt}, ${companies.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }

  return await timeQuery('companies.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select()
        .from(companies)
        .where(and(...conditions))
        .orderBy(desc(companies.createdAt), desc(companies.id))
        .limit(size + 1),
    );
    return buildPage(rows, size, (r) => ({
      ts: r.createdAt.toISOString(),
      id: r.id,
    }));
  });
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
 * Soft-deleted companies, paginated by `(deleted_at desc, id)`.
 */
export async function listDeletedCompanies(
  tenantId: string,
  options: { cursor?: Cursor | null; size?: PageSize } = {},
): Promise<Page<Company>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  return await timeQuery('companies.deleted', async () =>
    withIncludeDeleted(async () =>
      tenantTransaction(async (tx) => {
        const conditions = [
          eq(companies.tenantId, tenantId),
          isNotNull(companies.deletedAt),
        ];
        if (options.cursor) {
          conditions.push(
            sql`(${companies.deletedAt}, ${companies.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
          );
        }
        const rows = await tx
          .select()
          .from(companies)
          .where(and(...conditions))
          .orderBy(desc(companies.deletedAt), desc(companies.id))
          .limit(size + 1);
        return buildPage(rows, size, (r) => ({
          ts: (r.deletedAt ?? new Date(0)).toISOString(),
          id: r.id,
        }));
      }),
    ),
  );
}
