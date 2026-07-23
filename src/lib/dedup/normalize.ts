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
