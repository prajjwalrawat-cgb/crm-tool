import 'server-only';

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { companies, contacts, type Contact } from '@/db/schema';
import { type ContactFilters } from '@/lib/contacts/filters';
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';
import { UUID_REGEX_LITERAL } from '@/lib/db-sql/safe-uuid';

export type { ContactFilters } from '@/lib/contacts/filters';
import {
  buildPage,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  type Page,
  type PageSize,
} from '@/lib/pagination/cursor';
import { timeQuery } from '@/lib/pagination/timing';

export type ContactRow = Contact & {
  companyName: string | null;
};

export type ContactOption = {
  id: string;
  label: string;
};

export async function listContactOptions(tenantId: string): Promise<ContactOption[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          isNull(contacts.deletedAt),
          isNull(contacts.mergedIntoId),
        ),
      )
      .orderBy(
        asc(sql`coalesce(${contacts.lastName}, ${contacts.firstName}, ${contacts.email})`),
      ),
  );

  return rows.map((c) => {
    const nameParts = [c.firstName, c.lastName].filter(Boolean) as string[];
    const label = nameParts.length
      ? nameParts.join(' ')
      : c.email ?? '(unnamed)';
    return { id: c.id, label };
  });
}

export type ContactPickerOption = {
  id: string;
  label: string;
  companyId: string | null;
};

/**
 * Contact options for the deal form: each carries its `companyId` so the form
 * can filter the contact dropdown to the selected company. Scoped by role like
 * `listCompanyOptionsScoped` (sales members see their own + unassigned).
 */
export async function listContactPickerOptions(
  tenantId: string,
  restrictToOwnerId?: string,
): Promise<ContactPickerOption[]> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        companyId: contacts.companyId,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          isNull(contacts.deletedAt),
          isNull(contacts.mergedIntoId),
          restrictToOwnerId
            ? or(eq(contacts.ownerId, restrictToOwnerId), isNull(contacts.ownerId))
            : undefined,
        ),
      )
      .orderBy(
        asc(sql`coalesce(${contacts.lastName}, ${contacts.firstName}, ${contacts.email})`),
      ),
  );

  return rows.map((c) => {
    const nameParts = [c.firstName, c.lastName].filter(Boolean) as string[];
    const label = nameParts.length ? nameParts.join(' ') : c.email ?? '(unnamed)';
    return { id: c.id, label, companyId: c.companyId };
  });
}

export type ListContactsOptions = {
  search?: string;
  cursor?: Cursor | null;
  size?: PageSize;
  filters?: ContactFilters;
  /** Required for `filters.mine` to resolve "owner == me". */
  currentUserId?: string;
  /**
   * Hard-restrict to contacts owned by this user OR unassigned. Used
   * by sales-persona pages to enforce member visibility at SSR.
   */
  restrictToOwnerOrUnassigned?: string;
};

export async function listContacts(
  tenantId: string,
  options: ListContactsOptions = {},
): Promise<Page<ContactRow>> {
  const term = options.search?.trim();
  const size = options.size ?? DEFAULT_PAGE_SIZE;

  const conditions: SQL[] = [
    eq(contacts.tenantId, tenantId),
    isNull(contacts.deletedAt),
    // Module 5: merged-away duplicates are hidden like soft-deletes.
    isNull(contacts.mergedIntoId),
  ];
  if (term) {
    const pattern = `%${term}%`;
    const searchPredicate = or(
      ilike(contacts.firstName, pattern),
      ilike(contacts.lastName, pattern),
      ilike(contacts.email, pattern),
      ilike(contacts.title, pattern),
    );
    if (searchPredicate) conditions.push(searchPredicate);
  }
  const f = options.filters ?? {};
  if (f.companyId) {
    conditions.push(eq(contacts.companyId, f.companyId));
  }
  if (f.noCompany) {
    conditions.push(isNull(contacts.companyId));
  }
  if (typeof f.recentActivityDays === 'number') {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM activity_logs al
      WHERE al.tenant_id = ${tenantId}::uuid
        AND al.entity_type = 'contact'
        AND al.entity_id ~ ${sql.raw(`'${UUID_REGEX_LITERAL}'`)}
        AND al.entity_id::uuid = ${contacts.id}
        AND al.created_at >= NOW() - (${f.recentActivityDays}::int * INTERVAL '1 day')
    )`);
  }
  if (typeof f.createdWithinDays === 'number') {
    conditions.push(
      sql`${contacts.createdAt} >= NOW() - (${f.createdWithinDays}::int * INTERVAL '1 day')`,
    );
  }
  if (f.mine && options.currentUserId) {
    conditions.push(eq(contacts.ownerId, options.currentUserId));
  }
  if (f.unassigned) {
    conditions.push(isNull(contacts.ownerId));
  }
  if (options.restrictToOwnerOrUnassigned) {
    const me = options.restrictToOwnerOrUnassigned;
    conditions.push(
      sql`(${contacts.ownerId} = ${me} OR ${contacts.ownerId} IS NULL)`,
    );
  }
  if (options.cursor) {
    conditions.push(
      sql`(${contacts.createdAt}, ${contacts.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
    );
  }

  return await timeQuery('contacts.list', async () => {
    const rows = await tenantTransaction(async (tx) =>
      tx
        .select({
          id: contacts.id,
          tenantId: contacts.tenantId,
          companyId: contacts.companyId,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          phone: contacts.phone,
          title: contacts.title,
          ownerId: contacts.ownerId,
          createdAt: contacts.createdAt,
          updatedAt: contacts.updatedAt,
          updatedBy: contacts.updatedBy,
          customFields: contacts.customFields,
          deletedAt: contacts.deletedAt,
          deletedBy: contacts.deletedBy,
          normalizedName: contacts.normalizedName,
          mergedIntoId: contacts.mergedIntoId,
          dedupOverride: contacts.dedupOverride,
          companyName: companies.name,
        })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(size + 1),
    );
    return buildPage(rows, size, (r) => ({
      ts: r.createdAt.toISOString(),
      id: r.id,
    }));
  });
}

export async function getContactById(
  tenantId: string,
  id: string,
): Promise<Contact | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.id, id),
          isNull(contacts.deletedAt),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function listDeletedContacts(
  tenantId: string,
  options: { cursor?: Cursor | null; size?: PageSize } = {},
): Promise<Page<Contact>> {
  const size = options.size ?? DEFAULT_PAGE_SIZE;
  return await timeQuery('contacts.deleted', async () =>
    withIncludeDeleted(async () =>
      tenantTransaction(async (tx) => {
        const conditions: SQL[] = [
          eq(contacts.tenantId, tenantId),
          isNotNull(contacts.deletedAt),
        ];
        if (options.cursor) {
          conditions.push(
            sql`(${contacts.deletedAt}, ${contacts.id}) < (${options.cursor.ts}::timestamptz, ${options.cursor.id}::uuid)`,
          );
        }
        const rows = await tx
          .select()
          .from(contacts)
          .where(and(...conditions))
          .orderBy(desc(contacts.deletedAt), desc(contacts.id))
          .limit(size + 1);
        return buildPage(rows, size, (r) => ({
          ts: (r.deletedAt ?? new Date(0)).toISOString(),
          id: r.id,
        }));
      }),
    ),
  );
}
