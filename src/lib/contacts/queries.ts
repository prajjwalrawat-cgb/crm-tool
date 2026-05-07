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

import { db } from '@/db';
import { companies, contacts, type Contact } from '@/db/schema';

export type ContactRow = Contact & {
  companyName: string | null;
};

export type ContactOption = {
  id: string;
  label: string;
};

export async function listContactOptions(tenantId: string): Promise<ContactOption[]> {
  const rows = await db
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
};

export async function listContacts(
  tenantId: string,
  options: ListContactsOptions = {},
): Promise<ContactRow[]> {
  const term = options.search?.trim();

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

  const rows = await db
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
    .orderBy(desc(contacts.createdAt));

  return rows;
}

export async function getContactById(
  tenantId: string,
  id: string,
): Promise<Contact | null> {
  const [row] = await db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        eq(contacts.id, id),
        isNull(contacts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listDeletedContacts(tenantId: string): Promise<Contact[]> {
  return await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), isNotNull(contacts.deletedAt)))
    .orderBy(desc(contacts.deletedAt));
}
