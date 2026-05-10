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
import { tenantTransaction, withIncludeDeleted } from '@/lib/db-context';
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
      .where(and(eq(contacts.tenantId, tenantId), isNull(contacts.deletedAt)))
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

export type ListContactsOptions = {
  search?: string;
  cursor?: Cursor | null;
  size?: PageSize;
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
          createdAt: contacts.createdAt,
          updatedAt: contacts.updatedAt,
          deletedAt: contacts.deletedAt,
          deletedBy: contacts.deletedBy,
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
