import 'server-only';

import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { companies, companyRollups, type Company } from '@/db/schema';
import {
  type CompanyFilters,
  type CompanySort,
  DEFAULT_STALE_DAYS,
  type SortDir,
} from '@/lib/companies/filters';
import {
  type CompanyRollupFields,
  EMPTY_COMPANY_ROLLUP,
} from '@/lib/companies/rollup';
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
export type { CompanyRollupFields } from '@/lib/companies/rollup';

/**
 * A company plus its `company_rollups` row. The list returns this instead
 * of a bare `Company` so the table can show deal / pipeline / activity
 * state without a per-row drill-down, which is the whole point.
 */
export type CompanyListRow = Company & { rollup: CompanyRollupFields };

export type CompanyOption = {
  id: string;
  name: string;
};

export async function listCompanyOptions(tenantId: string): Promise<CompanyOption[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, tenantId),
          isNull(companies.deletedAt),
          isNull(companies.mergedIntoId),
        ),
      )
      .orderBy(asc(companies.name)),
  );
}

/**
 * Company options for the deal form, scoped by role. When `restrictToOwnerId`
 * is set (sales members), returns companies they own OR that are unassigned;
 * owners/managers pass `undefined` to see everything.
 */
export async function listCompanyOptionsScoped(
  tenantId: string,
  restrictToOwnerId?: string,
): Promise<CompanyOption[]> {
  return await tenantTransaction(async (tx) =>
    tx
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(
        and(
          eq(companies.tenantId, tenantId),
          isNull(companies.deletedAt),
          isNull(companies.mergedIntoId),
          restrictToOwnerId
            ? or(
                eq(companies.ownerId, restrictToOwnerId),
                isNull(companies.ownerId),
              )
            : undefined,
        ),
      )
      .orderBy(asc(companies.name)),
  );
}

export type ListCompaniesOptions = {
  search?: string;
  cursor?: Cursor | null;
  size?: PageSize;
  filters?: CompanyFilters;
  sort?: CompanySort;
  dir?: SortDir;
  /** Required for `filters.mine` to resolve "owner == me". */
  currentUserId?: string;
  /**
   * Hard-restrict to companies owned by this user OR unassigned. Used
   * by sales-persona pages to enforce member visibility at SSR.
   */
  restrictToOwnerOrUnassigned?: string;
};

/**
 * A company that has never been touched sorts as though it were touched
 * at the epoch, rather than being dropped from activity-ordered pages.
 *
 * NULL cannot ride a keyset cursor: `(NULL, id) < (x, y)` is NULL, not
 * false, so a page boundary landing on an untouched account would return
 * nothing and the list would look like it had ended. The deals list
 * solved the same problem for risk scores by excluding unscored deals,
 * which is right there — an unscored deal is not a low-risk deal. It is
 * wrong here: "nobody has ever touched this account" is not missing data,
 * it is the most stale an account can be, and sorting Last Activity
 * ascending to hunt for neglect must surface exactly those rows first.
 *
 * 1970 is safe as the sentinel because no row in this product can carry
 * an activity timestamp older than the product.
 */
const LAST_ACTIVITY_KEY = sql`COALESCE(${companyRollups.lastActivityAt}, TIMESTAMPTZ 'epoch')`;
const LAST_ACTIVITY_EPOCH_ISO = new Date(0).toISOString();

/** Major units in the URL, minor units in the column. */
const toMinor = (major: number): number => Math.round(major * 100);

/**
 * Active companies with their rollups, keyset-paginated.
 *
 * We SELECT `size + 1` rows so the helper can detect "is there another
 * page" without a separate COUNT(*).
 *
 * SHAPE OF THE PLAN. `company_rollups` (migration 0065) is a LATERAL view
 * rooted at `companies`, so this LEFT JOIN is a nested loop: the outer
 * ordered index scan feeds one parameterized probe per row and LIMIT cuts
 * it off. Under the default `recent` sort that means the rollups are
 * computed for ~51 accounts, not for the tenant — the list costs what it
 * cost before plus a handful of index lookups. The aggregate sorts
 * (`pipeline` / `won` / `activity`) have to rank every account the filters
 * admit, so they pay a tenant-wide pass; that is not a regression, it is
 * the definition of a global sort.
 *
 * FILTERS READ THE SAME COLUMNS THE TABLE RENDERS. `hasDeals`, `stale` and
 * `recentActivityDays` used to be their own EXISTS subqueries over
 * `activity_logs`, which meant a chip and the row beside it could disagree
 * and nothing on screen could settle it. Now the chip filters the column.
 */
export async function listCompanies(
  tenantId: string,
  options: ListCompaniesOptions = {},
): Promise<Page<CompanyListRow>> {
  const term = options.search?.trim();
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  const sort: CompanySort = options.sort ?? 'recent';
  const dir: SortDir = options.dir ?? 'desc';

  const f = options.filters ?? {};
  const conditions = [
    eq(companies.tenantId, tenantId),
    isNull(companies.deletedAt),
    isNull(companies.mergedIntoId),
  ];
  if (term) conditions.push(ilike(companies.name, `%${term}%`));

  // "Has active deals" is now literally "the Deals column counts at least
  // one open deal", so a filtered page always shows a Stage badge and a
  // non-dash Deals cell. It cannot be otherwise: same column, same row.
  if (f.hasDeals) {
    conditions.push(sql`${companyRollups.openDealCount} > 0`);
  }
  if (typeof f.recentActivityDays === 'number') {
    conditions.push(
      sql`${LAST_ACTIVITY_KEY} >= NOW() - (${f.recentActivityDays}::int * INTERVAL '1 day')`,
    );
  }
  if (typeof f.createdWithinDays === 'number') {
    conditions.push(
      sql`${companies.createdAt} >= NOW() - (${f.createdWithinDays}::int * INTERVAL '1 day')`,
    );
  }
  // Stale is the complement of Recently active over the same expression,
  // so no account can match both chips and none can match neither. The
  // epoch sentinel is what puts never-touched accounts on the stale side
  // rather than in the gap between the two.
  if (f.stale) {
    const days = f.staleDays && f.staleDays > 0 ? f.staleDays : DEFAULT_STALE_DAYS;
    conditions.push(
      sql`${LAST_ACTIVITY_KEY} < NOW() - (${days}::int * INTERVAL '1 day')`,
    );
  }
  if (typeof f.minOpen === 'number') {
    conditions.push(
      sql`${companyRollups.openPipelineValue} >= ${toMinor(f.minOpen)}::bigint`,
    );
  }
  if (typeof f.minWon === 'number') {
    conditions.push(
      sql`${companyRollups.wonLifetimeValue} >= ${toMinor(f.minWon)}::bigint`,
    );
  }
  if (f.mine && options.currentUserId) {
    conditions.push(eq(companies.ownerId, options.currentUserId));
  }
  if (f.unassigned) {
    conditions.push(isNull(companies.ownerId));
  }
  if (options.restrictToOwnerOrUnassigned) {
    const me = options.restrictToOwnerOrUnassigned;
    conditions.push(
      sql`(${companies.ownerId} = ${me} OR ${companies.ownerId} IS NULL)`,
    );
  }

  // One expression drives ORDER BY, the cursor predicate and the cursor
  // the page hands back. Splitting them is how keyset pagination silently
  // starts skipping or repeating rows: the three have to be the same key
  // or the boundary means nothing.
  const key =
    sort === 'deals'
      ? sql`${companyRollups.dealCount}`
      : sort === 'pipeline'
        ? sql`${companyRollups.openPipelineValue}`
        : sort === 'won'
          ? sql`${companyRollups.wonLifetimeValue}`
          : sort === 'activity'
            ? LAST_ACTIVITY_KEY
            : sql`${companies.createdAt}`;
  const numericSort = sort === 'deals' || sort === 'pipeline' || sort === 'won';

  if (options.cursor) {
    // Postgres tuple comparison is lexicographic, so this is the canonical
    // keyset predicate — `<` walks a descending order, `>` an ascending
    // one. `id` is the tie-break in the same direction, which is what
    // keeps accounts with identical pipelines from repeating across pages.
    const cmp = sql.raw(dir === 'asc' ? '>' : '<');
    // Numeric modes carry the boundary in `n`; the two timestamp modes
    // (`recent`, `activity`) both carry it in `ts`.
    const bound = numericSort
      ? sql`${options.cursor.n ?? 0}::bigint`
      : sql`${options.cursor.ts}::timestamptz`;
    conditions.push(
      sql`(${key}, ${companies.id}) ${cmp} (${bound}, ${options.cursor.id}::uuid)`,
    );
  }

  const orderDir = sql.raw(dir === 'asc' ? 'ASC' : 'DESC');

  /**
   * The keyset boundary for the two timestamp modes, at the precision
   * Postgres actually stores.
   *
   * `timestamptz` keeps MICROseconds; a JavaScript `Date` keeps
   * milliseconds. Round-tripping the boundary through `Date.toISOString()`
   * therefore truncates it, and the truncated value is on the wrong side
   * of the row it came from: paging ascending, `> '…123'` re-matches the
   * row whose real key is `…123456`, so the last row of every page opens
   * the next one; paging descending, `< '…123'` skips any row that shares
   * the millisecond but ran later inside it. The self-test catches the
   * first as duplicates and the second only when two rows land in the same
   * millisecond — which is why the descending case survived unnoticed in
   * the pre-existing `created_at` pagination.
   *
   * So the cursor value is read back out of Postgres as text at full
   * precision rather than reconstructed from the Date. Old millisecond
   * cursors still decode and still compare correctly; they are simply
   * coarser.
   */
  const tsKey = sort === 'activity' ? LAST_ACTIVITY_KEY : sql`${companies.createdAt}`;

  return await timeQuery('companies.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select({
          company: companies,
          cursorTs: sql<string>`to_char(${tsKey} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          rollup: {
            dealCount: companyRollups.dealCount,
            openDealCount: companyRollups.openDealCount,
            wonDealCount: companyRollups.wonDealCount,
            openPipelineValue: companyRollups.openPipelineValue,
            wonLifetimeValue: companyRollups.wonLifetimeValue,
            topStage: companyRollups.topStage,
            contactCount: companyRollups.contactCount,
            lastActivityAt: companyRollups.lastActivityAt,
          },
        })
        .from(companies)
        // The view returns exactly one row per company, so this join can
        // never drop or duplicate an account. It is a LEFT join anyway:
        // an inner join would make a rollup that failed to materialise
        // delete the company from the list, which is a far worse failure
        // than a row of dashes.
        .leftJoin(
          companyRollups,
          and(
            eq(companyRollups.tenantId, companies.tenantId),
            eq(companyRollups.companyId, companies.id),
          ),
        )
        .where(and(...conditions))
        .orderBy(sql`${key} ${orderDir}, ${companies.id} ${orderDir}`)
        .limit(size + 1),
    );

    // Paginate the RAW rows — they still carry `cursorTs`, which the
    // shaped row deliberately does not: it is a pagination detail, not
    // something a caller should be able to read off a company.
    const page = buildPage(
      rows.map((r) => ({ ...r, id: r.company.id })),
      size,
      (r) => ({
        // `ts` stays populated in every mode so an old cursor still decodes
        // and the cursor shape never becomes conditional — only which field
        // the predicate reads changes.
        ts: r.cursorTs ?? LAST_ACTIVITY_EPOCH_ISO,
        id: r.company.id,
        ...(sort === 'deals'
          ? { n: r.rollup?.dealCount ?? 0 }
          : sort === 'pipeline'
            ? { n: r.rollup?.openPipelineValue ?? 0 }
            : sort === 'won'
              ? { n: r.rollup?.wonLifetimeValue ?? 0 }
              : {}),
      }),
    );

    const items: CompanyListRow[] = page.items.map((r) => ({
      ...r.company,
      rollup: r.rollup
        ? {
            dealCount: r.rollup.dealCount ?? 0,
            openDealCount: r.rollup.openDealCount ?? 0,
            wonDealCount: r.rollup.wonDealCount ?? 0,
            openPipelineValue: r.rollup.openPipelineValue ?? 0,
            wonLifetimeValue: r.rollup.wonLifetimeValue ?? 0,
            topStage: r.rollup.topStage ?? null,
            contactCount: r.rollup.contactCount ?? 0,
            lastActivityAt: r.rollup.lastActivityAt ?? null,
          }
        : EMPTY_COMPANY_ROLLUP,
    }));

    return { ...page, items };
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
