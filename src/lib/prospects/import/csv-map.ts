import type { ProspectInput } from '@/lib/prospects/rules';
import { MAX_NOTES, SIZE_BANDS } from '@/lib/prospects/rules';

/**
 * Quick Dump CSV header mapping. Pure and client-safe (no `server-only`).
 * Headers are matched case- and punctuation-insensitively against a
 * synonym list; the first header that matches a field wins. Cells in
 * columns that map to nothing (an "Address" column, a second phone column)
 * are kept in the row's notes as "Header: value" lines, never dropped.
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
  companyName: ['company', 'company name', 'companyname', 'organisation', 'organization', 'organisation name', 'organization name', 'firm', 'firm name', 'account', 'account name', 'business', 'business name', 'party', 'party name', 'client', 'client name', 'customer', 'customer name'],
  contactName: ['contact', 'contact person', 'contact name', 'name', 'person', 'full name'],
  contactEmail: ['email', 'e-mail', 'mail', 'email id', 'email address', 'e-mail address', 'mail id'],
  contactPhone: ['phone', 'mobile', 'contact number', 'whatsapp', 'phone number', 'phone no', 'mobile number', 'mobile no', 'whatsapp number', 'contact no', 'tel', 'telephone', 'mob', 'mob.', 'mob no', 'cell'],
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

/** Appends `extra` lines to `base` notes, keeping the result within MAX_NOTES (cut with "…"). */
function withExtraNotes(base: string | null, extra: string[]): string | null {
  const parts = [base, ...extra].filter((p): p is string => !!p);
  if (parts.length === 0) return null;
  const all = parts.join('\n');
  return all.length <= MAX_NOTES ? all : `${all.slice(0, MAX_NOTES - 1)}…`;
}

/**
 * Turns CSV records into raw candidate rows (validated later with
 * prospectInputSchema). `headers` (all of the CSV's headers, in order) lets
 * cells in unmapped columns go into notes as "Header: value" lines.
 */
export function csvRowsToCandidates(
  rows: Array<Record<string, string>>,
  map: Partial<Record<keyof DumpRow, string>>,
  headers: string[] = [],
): Array<Record<string, unknown>> {
  const mapped = new Set(Object.values(map));
  const unmapped = headers.filter((h) => !mapped.has(h) && h.trim() !== '');
  const cell = (r: Record<string, string>, f: keyof DumpRow): string | null => {
    const h = map[f];
    const v = h === undefined ? '' : (r[h] ?? '').trim();
    return v || null;
  };
  return rows.map((r) => {
    const size = cell(r, 'sizeBand');
    const tags = cell(r, 'clusterTags');
    const extra = unmapped.flatMap((h) => {
      const v = (r[h] ?? '').trim();
      return v ? [`${h.trim()}: ${v}`] : [];
    });
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
      notes: withExtraNotes(cell(r, 'notes'), extra),
      confidence: 1,
      note: null,
    };
  });
}
