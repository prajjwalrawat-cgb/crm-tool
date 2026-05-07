import 'server-only';

import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import { companies, contacts, type Contact } from '@/db/schema';

export type ContactRow = Contact & {
  companyName: string | null;
};

export type ContactOption = {
  id: string;
  label: string;
};

/**
 * Lightweight projection for picker UIs. Label falls back through name → email
 * → '(unnamed)' so every option has something readable.
 */
export async function listContactOptions(tenantId: string): Promise<ContactOption[]> {
  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
    })
    .from(contacts)
    .where(eq(contacts.tenantId, tenantId))
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

/**
 * List contacts for a tenant, joined with the company name (if any). Search
 * does case-insensitive substring match across first/last/email/title — backed
 * by the (tenant_id, email) and (tenant_id, last_name) composite indexes for
 * the most common lookups.
 */
export async function listContacts(
  tenantId: string,
  options: ListContactsOptions = {},
): Promise<ContactRow[]> {
  const term = options.search?.trim();

  const conditions: SQL[] = [eq(contacts.tenantId, tenantId)];
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
      companyName: companies.name,
    })
    .from(contacts)
    .leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(and(...conditions))
    .orderBy(desc(contacts.createdAt));

  return rows;
}
