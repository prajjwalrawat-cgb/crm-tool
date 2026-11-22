import 'server-only';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { deals, users, type Prospect } from '@/db/schema';
import {
  findCompanyByDomain,
  findCompanyMatches,
  findContactByEmail,
  findContactByPhone,
} from '@/lib/dedup/queries';
import { companyNameCore, normalizeCompanyName } from '@/lib/dedup/normalize';
import { tenantTransaction } from '@/lib/db-context';

import type { MatchCandidate } from './rules';

/**
 * Existing records a prospect could be merged into before a new lead is made.
 * Strong matches block a plain promote; weak ones only warn.
 */
export async function findPromoteCandidates(tenantId: string, p: Prospect): Promise<MatchCandidate[]> {
  const out = new Map<string, MatchCandidate>();
  const add = (c: MatchCandidate) => {
    const key = `${c.kind}:${c.id}`;
    const prev = out.get(key);
    if (!prev || (prev.strength === 'weak' && c.strength === 'strong')) out.set(key, c);
  };

  const [byName, byDomain, byEmail, byPhone] = await Promise.all([
    findCompanyMatches(tenantId, p.companyName),
    p.domain ? findCompanyByDomain(tenantId, p.domain) : null,
    p.emailNormalized ? findContactByEmail(tenantId, p.emailNormalized) : null,
    p.phoneNormalized ? findContactByPhone(tenantId, p.phoneNormalized) : null,
  ]);

  for (const m of byName) {
    add({
      kind: 'company',
      id: m.id,
      label: m.label,
      sublabel: m.sublabel,
      strength: m.kind === 'exact' ? 'strong' : 'weak',
      reason: m.kind === 'exact' ? 'name' : 'fuzzy_name',
    });
  }
  if (byDomain) {
    add({ kind: 'company', id: byDomain.id, label: byDomain.label, sublabel: byDomain.sublabel, strength: 'strong', reason: 'domain' });
  }
  if (byEmail) add({ kind: 'contact', id: byEmail.id, label: byEmail.name, sublabel: null, strength: 'strong', reason: 'email' });
  if (byPhone) add({ kind: 'contact', id: byPhone.id, label: byPhone.label, sublabel: null, strength: 'strong', reason: 'phone' });

  // Open leads: on a strong-matched company, or typed with the same company name.
  const strongCompanyIds = [...out.values()].filter((c) => c.kind === 'company' && c.strength === 'strong').map((c) => c.id);
  const norm = normalizeCompanyName(p.companyName);
  const word = companyNameCore(norm).split(' ')[0] ?? '';
  const escaped = word.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const nameLike = word.length >= 2 ? sql`${deals.companyNameText} ILIKE ${'%' + escaped + '%'}` : sql`false`;
  const filter = strongCompanyIds.length
    ? sql`(${inArray(deals.companyId, strongCompanyIds)} OR ${nameLike})`
    : nameLike;

  const rows = await tenantTransaction((tx) =>
    tx
      .select({
        id: deals.id,
        name: deals.name,
        companyId: deals.companyId,
        companyNameText: deals.companyNameText,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        ownerId: deals.ownerId,
      })
      .from(deals)
      .leftJoin(users, eq(users.id, deals.ownerId))
      .where(and(eq(deals.tenantId, tenantId), eq(deals.stage, 'lead'), isNull(deals.deletedAt), filter))
      .limit(50),
  );
  for (const d of rows) {
    const byCompany = d.companyId != null && strongCompanyIds.includes(d.companyId);
    const byText = !!d.companyNameText && norm !== '' && normalizeCompanyName(d.companyNameText) === norm;
    if (!byCompany && !byText) continue;
    const owner = [d.firstName, d.lastName].filter(Boolean).join(' ').trim() || d.email;
    add({
      kind: 'open_lead',
      id: d.id,
      label: d.name,
      sublabel: d.ownerId ? (owner ?? 'Unassigned') : 'Unassigned',
      strength: 'strong',
      reason: 'open_lead',
    });
  }
  return [...out.values()];
}
