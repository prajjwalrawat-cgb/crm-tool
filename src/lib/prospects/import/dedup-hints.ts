import 'server-only';

import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';

import { companies, contacts, prospects } from '@/db/schema';
import { normalizeCompanyName, normalizeEmail } from '@/lib/dedup/normalize';
import { domainHost, findCompanyMatches, storedCompanyDomainHost } from '@/lib/dedup/queries';
import { tenantTransaction } from '@/lib/db-context';
import { normalizePhone } from '@/lib/lead-capture/normalize';

import type { DumpRow } from './csv-map';

/**
 * Possible duplicates for Quick Dump preview rows. Informational only: the
 * person reviewing decides; nothing is blocked or merged here.
 *
 * Exact checks are batched: one query per hint kind for the whole import
 * (prospect name, company name, company domain, contact email, contact
 * phone). The fuzzy company-name search (findCompanyMatches) runs only for
 * rows with no exact company-name hit, and only for the first FUZZY_ROWS rows.
 */
export type DedupHint = { index: number; kind: 'prospect' | 'company' | 'contact'; label: string };

/** Company-name matches shown per row. */
const COMPANY_LIMIT = 3;
/** Rows that get the fuzzy company-name search (one query each). */
const FUZZY_ROWS = 100;
/** Fuzzy searches at once (the pool has 10 connections; leave room for other requests). */
const CONCURRENCY = 4;

const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
const personName = (first: string | null, last: string | null) => [first, last].filter(Boolean).join(' ').trim();

export async function computeDedupHints(tenantId: string, rows: DumpRow[]): Promise<DedupHint[]> {
  const names = rows.map((r) => normalizeCompanyName(r.companyName));
  const hosts = rows.map((r) => (r.domain ? domainHost(r.domain) : null));
  const emails = rows.map((r) => normalizeEmail(r.contactEmail) || null);
  const phones = rows.map((r) => normalizePhone(r.contactPhone));

  const wantedNames = uniq(names);
  const wantedCompanyNames = wantedNames.filter((n) => n.length >= 2);
  const wantedHosts = uniq(hosts);
  const wantedEmails = uniq(emails);
  const wantedPhones = uniq(phones);

  const found = await tenantTransaction(async (tx) => {
    const prospectRows = wantedNames.length
      ? await tx
          .select({ name: prospects.companyName, key: prospects.normalizedName })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tenantId), isNull(prospects.deletedAt), inArray(prospects.normalizedName, wantedNames)))
      : [];
    const activeCompany = and(eq(companies.tenantId, tenantId), isNull(companies.deletedAt), isNull(companies.mergedIntoId));
    const companyRows = wantedCompanyNames.length
      ? await tx
          .select({ name: companies.name, key: companies.normalizedName })
          .from(companies)
          .where(and(activeCompany, inArray(companies.normalizedName, wantedCompanyNames)))
          .orderBy(companies.name)
      : [];
    const storedHost = storedCompanyDomainHost();
    const domainRows = wantedHosts.length
      ? await tx
          .select({ name: companies.name, key: sql<string>`${storedHost}` })
          .from(companies)
          .where(and(activeCompany, isNotNull(companies.domain), inArray(storedHost, wantedHosts)))
      : [];
    const activeContact = and(eq(contacts.tenantId, tenantId), isNull(contacts.deletedAt), isNull(contacts.mergedIntoId));
    const lowerEmail = sql<string>`lower(${contacts.email})`;
    const emailRows = wantedEmails.length
      ? await tx
          .select({ first: contacts.firstName, last: contacts.lastName, key: lowerEmail })
          .from(contacts)
          .where(and(activeContact, inArray(lowerEmail, wantedEmails)))
      : [];
    const phoneRows = wantedPhones.length
      ? await tx
          .select({ first: contacts.firstName, last: contacts.lastName, key: contacts.phoneNormalized })
          .from(contacts)
          .where(and(activeContact, inArray(contacts.phoneNormalized, wantedPhones)))
      : [];
    return { prospectRows, companyRows, domainRows, emailRows, phoneRows };
  });

  /** First label per key (the single-row lookups also took one). */
  const firstBy = <T extends { key: string | null }>(list: T[], label: (t: T) => string) => {
    const m = new Map<string, string>();
    for (const t of list) if (t.key && !m.has(t.key)) m.set(t.key, label(t));
    return m;
  };
  const prospectBy = firstBy(found.prospectRows, (p) => p.name);
  const domainBy = firstBy(found.domainRows, (c) => c.name);
  const emailBy = firstBy(found.emailRows, (c) => personName(c.first, c.last) || (c.key ?? ''));
  const phoneBy = firstBy(found.phoneRows, (c) => personName(c.first, c.last) || (c.key ?? ''));
  const companiesBy = new Map<string, string[]>();
  for (const c of found.companyRows) {
    if (!c.key) continue;
    const list = companiesBy.get(c.key) ?? [];
    if (list.length < COMPANY_LIMIT) list.push(c.name);
    companiesBy.set(c.key, list);
  }

  // Fuzzy company-name search: rows with no exact company hit, first FUZZY_ROWS rows only.
  const fuzzy = new Map<number, string[]>();
  const fuzzyRows = rows
    .slice(0, FUZZY_ROWS)
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !companiesBy.has(names[i]!));
  for (let start = 0; start < fuzzyRows.length; start += CONCURRENCY) {
    await Promise.all(
      fuzzyRows.slice(start, start + CONCURRENCY).map(async ({ r, i }) => {
        const matches = await findCompanyMatches(tenantId, r.companyName, COMPANY_LIMIT);
        if (matches.length) fuzzy.set(i, matches.map((m) => m.label));
      }),
    );
  }

  const hints: DedupHint[] = [];
  rows.forEach((_, i) => {
    const seen = new Set<string>();
    const add = (kind: DedupHint['kind'], label: string | undefined) => {
      if (!label || seen.has(`${kind}|${label}`)) return;
      seen.add(`${kind}|${label}`);
      hints.push({ index: i, kind, label });
    };
    add('prospect', prospectBy.get(names[i]!));
    for (const label of companiesBy.get(names[i]!) ?? fuzzy.get(i) ?? []) add('company', label);
    if (hosts[i]) add('company', domainBy.get(hosts[i]!));
    if (emails[i]) add('contact', emailBy.get(emails[i]!));
    if (phones[i]) add('contact', phoneBy.get(phones[i]!));
  });
  return hints;
}
