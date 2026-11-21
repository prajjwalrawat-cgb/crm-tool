/**
 * Module 5 — Duplicate detection. Pure, dependency-free name/email normalizers
 * used both to compute the stored `normalized_name` (for the pg_trgm index) and
 * to normalize a typed query before matching. Same input → same output.
 */

/**
 * Legal-entity suffixes stripped during normalization so "Acme Ltd", "Acme
 * Limited" and "Acme Pvt Ltd" all collapse to "acme". Kept broad but safe —
 * only whole-token matches are removed.
 */
const LEGAL_SUFFIX_TOKENS = new Set([
  'ltd',
  'limited',
  'pvt',
  'private',
  'llp',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'llc',
  'gmbh',
  'sarl',
  'bv',
  'ag',
]);

// Combining diacritical marks (U+0300–U+036F), removed after NFKD decomposition.
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Normalize a company name for matching:
 *   lowercase → strip accents → drop punctuation → collapse whitespace →
 *   remove legal-suffix tokens.
 * Falls back to the punctuation-stripped form if every token was a suffix (so a
 * name like "Ltd" never normalizes to an empty string).
 */
export function normalizeCompanyName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter((t) => t && !LEGAL_SUFFIX_TOKENS.has(t));
  const normalized = tokens.join(' ').trim();
  return normalized || cleaned;
}

/**
 * Words that say what a company does, not which company it is. "L&T Technology"
 * and "Speridian Technology" share "technology" and little else, yet trigram
 * matching on the whole name scores them alike (0.79): fuzzy matching compares
 * names with these words taken out, so only the distinctive part counts.
 * Whole tokens of an already-normalized name, lowercase.
 */
export const GENERIC_COMPANY_WORDS = [
  'technology', 'technologies', 'tech', 'techno', 'technical',
  'solution', 'solutions', 'service', 'services', 'system', 'systems',
  'software', 'softwares', 'infotech', 'it',
  'consulting', 'consultancy', 'consultant', 'consultants',
  'global', 'india', 'indian', 'international', 'group',
  'enterprise', 'enterprises', 'industry', 'industries',
  'digital', 'labs', 'networks', 'ventures', 'and', 'the', 'of',
] as const;

const GENERIC = new Set<string>(GENERIC_COMPANY_WORDS);

/**
 * The same words as a Postgres regex (\m and \M are its word boundaries), so
 * SQL can take them out of a stored `normalized_name` exactly as
 * `companyNameCore` takes them out of a typed one.
 */
export const GENERIC_COMPANY_WORDS_PG_RE = `\\m(?:${GENERIC_COMPANY_WORDS.join('|')})\\M`;

/**
 * The distinctive part of a normalized company name: its generic words taken
 * out. "l t technology" → "l t"; "yash technologies" → "yash". Empty when the
 * name is nothing but generic words ("technology solutions").
 */
export function companyNameCore(normalized: string): string {
  return normalized
    .split(' ')
    .filter((t) => t && !GENERIC.has(t))
    .join(' ');
}

/** Normalize a contact's full name (first + last) for fuzzy matching. */
export function normalizeContactName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  const full = `${firstName ?? ''} ${lastName ?? ''}`;
  return full
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical email for exact, case-insensitive matching. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}
