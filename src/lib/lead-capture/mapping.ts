import type { FieldMapping } from '@/db/schema/lead-capture';

import { LEAD_FIELD_KEYS, type LeadFieldKey } from './constants';
import { cleanText, normalizeEmail, normalizePhone } from './normalize';

/**
 * Field mapping: turns an arbitrary inbound payload (webhook JSON, form post,
 * CSV row) into the fixed lead shape. Pure.
 */

export { LEAD_FIELD_KEYS, type LeadFieldKey };

export type MappedLead = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  company: string | null;
  title: string | null;
  city: string | null;
  state: string | null;
  productInterest: string | null;
  message: string | null;
  utm: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
    term: string | null;
    content: string | null;
  };
  landingUrl: string | null;
  referrerUrl: string | null;
  consent: boolean | null;
  custom: Record<string, string>;
};

/**
 * Used when a source has no explicit mapping for a field: common inbound
 * names (IndiaMART, JustDial, Meta, generic forms) for each lead key.
 * Matching is on the lower-cased name with spaces/dashes as underscores.
 */
const ALIASES: Record<LeadFieldKey, string[]> = {
  full_name: ['full_name', 'name', 'sender_name', 'contact_name', 'customer_name', 'your_name'],
  first_name: ['first_name', 'firstname', 'fname', 'given_name'],
  last_name: ['last_name', 'lastname', 'lname', 'surname', 'family_name'],
  email: ['email', 'email_address', 'sender_email', 'e_mail', 'mail', 'your_email'],
  phone: ['phone', 'phone_number', 'mobile', 'mobile_number', 'sender_mobile', 'contact_number', 'whatsapp', 'tel', 'telephone', 'your_phone'],
  company: ['company', 'company_name', 'organisation', 'organization', 'sender_company', 'business_name', 'firm'],
  title: ['title', 'job_title', 'designation', 'role'],
  city: ['city', 'sender_city', 'town'],
  state: ['state', 'sender_state', 'province', 'region'],
  product_interest: ['product_interest', 'product', 'product_name', 'query_product_name', 'interested_in', 'requirement', 'service'],
  message: ['message', 'query_message', 'comments', 'comment', 'enquiry', 'inquiry', 'description', 'notes'],
  utm_source: ['utm_source'],
  utm_medium: ['utm_medium'],
  utm_campaign: ['utm_campaign', 'campaign', 'campaign_name'],
  utm_term: ['utm_term'],
  utm_content: ['utm_content'],
  landing_url: ['landing_url', 'landing_page', 'page_url', 'url'],
  referrer_url: ['referrer_url', 'referrer', 'referer'],
  consent: ['consent', 'consent_given', 'gdpr', 'agree', 'accept_terms'],
};

const canon = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Flatten one level of nesting ("lead": {...}) and Meta-style field_data. */
export function flattenPayload(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (k === 'field_data' && Array.isArray(v)) {
      // Meta lead ads: [{ name: 'email', values: ['a@b.c'] }, …]
      for (const item of v) {
        if (item && typeof item === 'object' && 'name' in item) {
          const values = (item as { values?: unknown[] }).values;
          out[String((item as { name: unknown }).name)] = Array.isArray(values) ? values[0] : undefined;
        }
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (!(k2 in out)) out[k2] = v2;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function parseConsent(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'checked', 'agree', 'agreed'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

/**
 * Apply `mapping` (inbound key → lead key or `custom.<key>`) to `payload`.
 * Explicit mappings win; unmapped lead keys fall back to ALIASES.
 */
export function applyFieldMapping(payload: unknown, mapping: FieldMapping = {}): MappedLead {
  const flat = flattenPayload(payload);
  const byCanon = new Map<string, unknown>();
  for (const [k, v] of Object.entries(flat)) byCanon.set(canon(k), v);

  const values: Partial<Record<LeadFieldKey, unknown>> = {};
  const custom: Record<string, string> = {};
  const consumed = new Set<string>();

  for (const [inbound, target] of Object.entries(mapping)) {
    const v = byCanon.get(canon(inbound));
    if (v === undefined) continue;
    consumed.add(canon(inbound));
    if (target.startsWith('custom.')) {
      const t = cleanText(v);
      if (t) custom[target.slice('custom.'.length)] = t;
    } else if ((LEAD_FIELD_KEYS as readonly string[]).includes(target)) {
      values[target as LeadFieldKey] = v;
    }
  }
  for (const key of LEAD_FIELD_KEYS) {
    if (values[key] !== undefined) continue;
    for (const alias of ALIASES[key]) {
      if (consumed.has(alias)) continue;
      const v = byCanon.get(alias);
      if (v !== undefined && v !== null && v !== '') {
        values[key] = v;
        break;
      }
    }
  }

  let firstName = cleanText(values.first_name, 200);
  let lastName = cleanText(values.last_name, 200);
  const full = cleanText(values.full_name, 400);
  if (!firstName && !lastName && full) {
    const parts = full.split(' ');
    firstName = parts[0] ?? null;
    lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
  }

  const email = cleanText(values.email, 320);
  const phone = cleanText(values.phone, 40);
  return {
    firstName,
    lastName,
    email,
    emailNormalized: normalizeEmail(email),
    phone,
    phoneNormalized: normalizePhone(phone),
    company: cleanText(values.company, 300),
    title: cleanText(values.title, 200),
    city: cleanText(values.city, 120),
    state: cleanText(values.state, 120),
    productInterest: cleanText(values.product_interest, 300),
    message: cleanText(values.message, 5000),
    utm: {
      source: cleanText(values.utm_source, 200),
      medium: cleanText(values.utm_medium, 200),
      campaign: cleanText(values.utm_campaign, 200),
      term: cleanText(values.utm_term, 200),
      content: cleanText(values.utm_content, 200),
    },
    landingUrl: cleanText(values.landing_url, 2000),
    referrerUrl: cleanText(values.referrer_url, 2000),
    consent: parseConsent(values.consent),
    custom,
  };
}

/** Why a mapped lead cannot be created, or null if it can. */
export function validateMappedLead(lead: MappedLead): string | null {
  if (!lead.phoneNormalized && !lead.emailNormalized) {
    if (lead.phone || lead.email) return 'phone and email are both invalid';
    return 'need at least a phone or an email';
  }
  return null;
}

/** Display name for the lead's deal: company, else person, else contact detail. */
export function leadDisplayName(lead: MappedLead): string {
  const person = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  const who = lead.company ?? (person || lead.emailNormalized || lead.phoneNormalized || 'Lead');
  return lead.productInterest ? `${who} – ${lead.productInterest}` : `${who} – enquiry`;
}

/**
 * Heuristic column mapping for CSV import: each header is matched against the
 * alias table (exact canonical match first, then "contains" for longer
 * headers like "Customer Mobile No"). Each lead field is used at most once.
 */
export function suggestMappingHeuristic(headers: string[]): Record<string, LeadFieldKey | null> {
  const out: Record<string, LeadFieldKey | null> = {};
  const used = new Set<LeadFieldKey>();
  const pass = (match: (h: string, alias: string) => boolean) => {
    for (const header of headers) {
      if (out[header]) continue;
      const h = canon(header);
      for (const key of LEAD_FIELD_KEYS) {
        if (used.has(key)) continue;
        if (ALIASES[key].some((a) => match(h, a))) {
          out[header] = key;
          used.add(key);
          break;
        }
      }
    }
  };
  pass((h, a) => h === a);
  pass((h, a) => a.length >= 4 && (h.includes(a) || h.replace(/_/g, '').includes(a.replace(/_/g, ''))));
  for (const header of headers) if (!(header in out)) out[header] = null;
  return out;
}
