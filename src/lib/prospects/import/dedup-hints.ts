import 'server-only';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { prospects } from '@/db/schema';
import { normalizeCompanyName } from '@/lib/dedup/normalize';
import { findCompanyByDomain, findCompanyMatches, findContactByEmail, findContactByPhone } from '@/lib/dedup/queries';
import { tenantTransaction } from '@/lib/db-context';
import { normalizePhone } from '@/lib/lead-capture/normalize';

import type { DumpRow } from './csv-map';

/**
 * Possible duplicates for Quick Dump preview rows. Informational only: the
 * person reviewing decides; nothing is blocked or merged here.
 */
export type DedupHint = { index: number; kind: 'prospect' | 'company' | 'contact'; label: string };

/** Company-name matches shown per row. */
const COMPANY_LIMIT = 3;
/** Rows checked at once (the pool has 10 connections; leave room for other requests). */
const CONCURRENCY = 4;

export async function computeDedupHints(tenantId: string, rows: DumpRow[]): Promise<DedupHint[]> {
  const hints: DedupHint[] = [];
  const seen = new Set<string>();
  const add = (index: number, kind: DedupHint['kind'], label: string) => {
    const key = `${index}|${kind}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ index, kind, label });
  };

  // Prospects: exact normalized name among non-deleted prospects, in one query.
  const names = rows.map((r) => normalizeCompanyName(r.companyName));
  const wanted = [...new Set(names.filter((n) => n.length > 0))];
  if (wanted.length > 0) {
    const existing = await tenantTransaction((tx) =>
      tx
        .select({ name: prospects.companyName, norm: prospects.normalizedName })
        .from(prospects)
        .where(and(eq(prospects.tenantId, tenantId), isNull(prospects.deletedAt), inArray(prospects.normalizedName, wanted))),
    );
    const byNorm = new Map<string, string>();
    for (const p of existing) if (p.norm && !byNorm.has(p.norm)) byNorm.set(p.norm, p.name);
    names.forEach((n, i) => {
      const label = byNorm.get(n);
      if (label) add(i, 'prospect', label);
    });
  }

  // CRM companies and contacts, a few rows at a time.
  // Each row's checks run in turn so a 500-row dump holds at most CONCURRENCY pool connections.
  const checkRow = async (row: DumpRow, i: number) => {
    for (const c of await findCompanyMatches(tenantId, row.companyName, COMPANY_LIMIT)) add(i, 'company', c.label);
    const byDomain = row.domain ? await findCompanyByDomain(tenantId, row.domain) : null;
    if (byDomain) add(i, 'company', byDomain.label);
    const byEmail = row.contactEmail ? await findContactByEmail(tenantId, row.contactEmail) : null;
    if (byEmail) add(i, 'contact', byEmail.name);
    const phone = normalizePhone(row.contactPhone);
    const byPhone = phone ? await findContactByPhone(tenantId, phone) : null;
    if (byPhone) add(i, 'contact', byPhone.label);
  };
  for (let start = 0; start < rows.length; start += CONCURRENCY) {
    await Promise.all(rows.slice(start, start + CONCURRENCY).map((r, k) => checkRow(r, start + k)));
  }

  return hints.sort((a, b) => a.index - b.index);
}
