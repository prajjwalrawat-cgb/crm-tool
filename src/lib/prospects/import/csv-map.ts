import type { ProspectInput } from '@/lib/prospects/rules';
import { SIZE_BANDS } from '@/lib/prospects/rules';

/**
 * Quick Dump CSV header mapping. Pure and client-safe (no `server-only`).
 * Headers are matched case- and punctuation-insensitively against a
 * synonym list; the first header that matches a field wins.
 */

/** One parsed dump row: a prospect without its sourceTag, plus how sure the parser is. */
export type DumpRow = Omit<ProspectInput, 'sourceTag'> & {
  /** 0 to 1. Deterministic CSV rows are 1. */
  confidence: number;
  /** Why a row is uncertain, or null. */
  note: string | null;
};

export type CsvMappableField =
  | 'companyName'
  | 'contactName'
  | 'contactEmail'
  | 'contactPhone'
  | 'contactDesignation'
  | 'domain'
  | 'city'
  | 'state'
  | 'industry'
  | 'sizeBand'
  | 'clusterTags'
  | 'notes';

/** Lower-case, letters and digits only ("E-mail" -> "email", "Company Name" -> "companyname"). */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const SYNONYMS: Record<CsvMappableField, string[]> = {
  companyName: ['company', 'company name', 'companyname', 'organisation', 'organization', 'organisation name', 'organization name', 'firm', 'firm name', 'account', 'account name', 'business', 'business name'],
  contactName: ['contact', 'contact person', 'contact name', 'name', 'person', 'full name'],
  contactEmail: ['email', 'e-mail', 'mail', 'email id', 'email address', 'e-mail address', 'mail id'],
  contactPhone: ['phone', 'mobile', 'contact number', 'whatsapp', 'phone number', 'phone no', 'mobile number', 'mobile no', 'whatsapp number', 'contact no', 'tel', 'telephone'],
  contactDesignation: ['designation', 'title', 'role', 'job title', 'position'],
  domain: ['website', 'domain', 'url', 'web', 'site', 'website url', 'web site'],
  city: ['city', 'town'],
  state: ['state'],
  industry: ['industry', 'sector', 'vertical'],
  sizeBand: ['size', 'employees', 'company size', 'no of employees', 'number of employees', 'employee count', 'headcount', 'size band'],
  clusterTags: ['tags', 'tag', 'labels', 'cluster tags'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment'],
};

const LOOKUP = new Map<string, CsvMappableField>();
for (const [field, words] of Object.entries(SYNONYMS) as Array<[CsvMappableField, string[]]>) {
  for (const w of words) LOOKUP.set(norm(w), field);
}

export function mapCsvHeaders(headers: string[]): Partial<Record<keyof DumpRow, string>> {
  const out: Partial<Record<keyof DumpRow, string>> = {};
  for (const h of headers) {
    const field = LOOKUP.get(norm(h));
    if (field && out[field] === undefined) out[field] = h;
  }
  return out;
}

/** Turns CSV records into raw candidate rows (validated later with prospectInputSchema). */
export function csvRowsToCandidates(
  rows: Array<Record<string, string>>,
  map: Partial<Record<keyof DumpRow, string>>,
): Array<Record<string, unknown>> {
  const cell = (r: Record<string, string>, f: keyof DumpRow): string | null => {
    const h = map[f];
    const v = h === undefined ? '' : (r[h] ?? '').trim();
    return v || null;
  };
  return rows.map((r) => {
    const size = cell(r, 'sizeBand');
    const tags = cell(r, 'clusterTags');
    return {
      companyName: cell(r, 'companyName') ?? '',
      contactName: cell(r, 'contactName'),
      contactDesignation: cell(r, 'contactDesignation'),
      contactEmail: cell(r, 'contactEmail'),
      contactPhone: cell(r, 'contactPhone'),
      domain: cell(r, 'domain'),
      industry: cell(r, 'industry'),
      sizeBand: size && (SIZE_BANDS as readonly string[]).includes(size) ? size : null,
      city: cell(r, 'city'),
      state: cell(r, 'state'),
      clusterTags: tags ? tags.split(/[,;|]/) : [],
      notes: cell(r, 'notes'),
      confidence: 1,
      note: null,
    };
  });
}
