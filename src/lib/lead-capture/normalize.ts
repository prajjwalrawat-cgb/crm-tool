import {
  parsePhoneNumberFromString as parseWithMetadata,
  type CountryCode,
  type MetadataJson,
} from 'libphonenumber-js/core';
import * as minMetadata from 'libphonenumber-js/min/metadata';

// The metadata module is JSON-as-JS; depending on the loader (Next's bundler
// vs tsx's CJS interop) it arrives as the object itself or wrapped in one or
// two `default` layers. Unwrap until we reach `{ countries }`.
function unwrapMetadata(m: unknown): MetadataJson {
  let cur = m as { countries?: unknown; default?: unknown };
  for (let i = 0; i < 3 && cur && !cur.countries; i++) cur = cur.default as typeof cur;
  return cur as unknown as MetadataJson;
}
const METADATA = unwrapMetadata(minMetadata);
const parsePhoneNumberFromString = (value: string, country?: CountryCode) =>
  country ? parseWithMetadata(value, country, METADATA) : parseWithMetadata(value, METADATA);

/**
 * Pure, dependency-light normalizers used by lead dedupe. Same input → same
 * output; no I/O. The stored `contacts.phone_normalized` / `email_normalized`
 * columns are always produced by these two functions.
 */

/**
 * Normalize a phone number to E.164, or null if it is not a valid number.
 *
 * Indian numbers arrive in many shapes — "+91 98765 43210", "098765 43210",
 * "9876543210", "91-9876543210", "0091 98765 43210" — and all of them must
 * collapse to "+919876543210" or dedupe misses the repeat enquiry.
 */
export function normalizePhone(
  raw: unknown,
  defaultCountry: CountryCode = 'IN',
): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Drop extensions ("ext 12", "x12") — they are not part of the identity.
  s = s.replace(/\s*(?:ext\.?|x|#)\s*\d+$/i, '');
  // "0091…" / "00 91…" → "+91…" (international dial-out prefix).
  s = s.replace(/^\s*00\s*/, '+');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;

  const tryParse = (value: string, country?: CountryCode): string | null => {
    const parsed = parsePhoneNumberFromString(value, country);
    return parsed && parsed.isValid() ? parsed.number : null;
  };

  if (s.startsWith('+')) return tryParse(`+${digits}`);
  // National form first ("098765 43210", "9876543210").
  const national = tryParse(digits, defaultCountry);
  if (national) return national;
  // Country code without the plus ("91 98765 43210").
  return tryParse(`+${digits}`);
}

/** Lower-case + trim; null unless it looks like an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Strip HTML tags and control characters from an inbound text value. The raw
 * payload is kept untouched in `lead_ingest_events`; mapped fields are stored
 * clean and the UI renders them escaped.
 */
export function cleanText(raw: unknown, maxLength = 2000): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    return null;
  }
  const s = String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.slice(0, maxLength);
}
