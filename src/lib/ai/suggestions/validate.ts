import { z } from 'zod';

import type { FollowUpValue, SuggestionField, SuggestionValue } from '@/db/schema/ai-suggestions';
import { PROSPECT_SIZE_BANDS } from '@/db/schema/prospects';
import { DEAL_STAGES } from '@/lib/deals/schema';
import { normalizePhone } from '@/lib/lead-capture/normalize';

/**
 * Validation for AI suggestions. Pure (no SDK, no DB) so selftests can feed
 * it bad model output directly. Used twice: on extractor output (drop
 * anything invalid) and on a user's edit-and-accept value.
 *
 * Defences against a confused or manipulated model:
 *  - every value is re-validated per field (stage enum, real future dates,
 *    positive amounts, valid email/phone);
 *  - the evidence quote must appear verbatim in the conversation (call /
 *    email only; prospect enrichment has no source text, so its evidence is
 *    the model's reasoning, see validateEnrichment);
 *  - a quote that reads like an instruction to the AI is dropped;
 *  - fields are restricted to the entity they belong to;
 *  - a "change" equal to the current value is dropped (nothing to review).
 */

export const DEAL_FIELDS = ['stage', 'amount', 'close_date', 'next_step', 'follow_up_task'] as const;
export const CONTACT_FIELDS = ['contact_name', 'contact_email', 'contact_phone', 'contact_designation'] as const;

export { FIELD_LABELS } from './view';

/** Raw item as the model returns it (matches SUGGESTION_TOOL's schema). */
export const rawSuggestionSchema = z.object({
  target: z.enum(['deal', 'contact']),
  field: z.string(),
  value: z.string().max(500),
  due_date: z.string().nullable(),
  evidence_quote: z.string().min(1).max(500),
  confidence: z.number(),
});
export const rawOutputSchema = z.object({ suggestions: z.array(rawSuggestionSchema).max(20) });
export type RawSuggestion = z.infer<typeof rawSuggestionSchema>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function realDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** A date strictly after `today` and within 3 years. */
export function isFutureDate(s: string, today: string): boolean {
  if (!realDate(s) || s <= today) return false;
  const max = new Date(`${today}T00:00:00Z`);
  max.setUTCFullYear(max.getUTCFullYear() + 3);
  return s <= max.toISOString().slice(0, 10);
}

export type FieldCheck = { ok: true; value: SuggestionValue } | { ok: false; error: string };

/** Validate + normalise a value for one field. `raw` is the model's string (or a user's edit). */
export function validateFieldValue(
  field: SuggestionField,
  raw: unknown,
  ctx: { today: string; dueDate?: string | null; offeringIds?: readonly string[] },
): FieldCheck {
  const str = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  switch (field) {
    case 'stage': {
      const v = str.toLowerCase();
      return (DEAL_STAGES as readonly string[]).includes(v) ? { ok: true, value: v } : { ok: false, error: `"${str}" is not a deal stage` };
    }
    case 'amount': {
      const n = Number(str.replace(/[,\s₹]/g, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 999_999_999_999) return { ok: false, error: 'Amount must be a positive number' };
      return { ok: true, value: Math.round(n * 100) / 100 };
    }
    case 'close_date':
      return isFutureDate(str, ctx.today) ? { ok: true, value: str } : { ok: false, error: 'Close date must be a real date in the future' };
    case 'next_step':
      return str.length >= 3 && str.length <= 500 ? { ok: true, value: str } : { ok: false, error: 'Next step must be 3–500 characters' };
    case 'contact_name':
      return str.length >= 2 && str.length <= 200 && !/[@\d]{3,}/.test(str) ? { ok: true, value: str } : { ok: false, error: 'Not a valid name' };
    case 'contact_email': {
      const r = z.email().max(255).safeParse(str.toLowerCase());
      return r.success ? { ok: true, value: r.data } : { ok: false, error: 'Not a valid email address' };
    }
    case 'contact_phone': {
      const p = normalizePhone(str);
      return p ? { ok: true, value: p } : { ok: false, error: 'Not a valid phone number' };
    }
    case 'contact_designation':
      return str.length >= 2 && str.length <= 100 ? { ok: true, value: str } : { ok: false, error: 'Designation must be 2–100 characters' };
    case 'follow_up_task': {
      const obj = (typeof raw === 'object' && raw !== null ? raw : null) as Partial<FollowUpValue> | null;
      const title = (obj?.title ?? str).trim();
      const due = (obj?.due_date ?? ctx.dueDate ?? '').trim();
      if (title.length < 3 || title.length > 200) return { ok: false, error: 'Task title must be 3–200 characters' };
      if (!isFutureDate(due, ctx.today)) return { ok: false, error: 'Follow-up date must be a real date in the future' };
      return { ok: true, value: { title, due_date: due } };
    }
    // Prospect enrichment fields (0079).
    case 'industry':
      return str.length >= 2 && str.length <= 80 ? { ok: true, value: str } : { ok: false, error: 'Industry must be 2–80 characters' };
    case 'size_band':
      return (PROSPECT_SIZE_BANDS as readonly string[]).includes(str)
        ? { ok: true, value: str }
        : { ok: false, error: `"${str}" is not a size band` };
    case 'product_fit': {
      const id = str.toLowerCase();
      if (!UUID.test(id)) return { ok: false, error: 'Not a known offering' };
      // When the caller knows the tenant's offerings, the id must be one of them.
      if (ctx.offeringIds && !ctx.offeringIds.includes(id)) return { ok: false, error: 'Not a known offering' };
      return { ok: true, value: id };
    }
    case 'icp_score': {
      const n = typeof raw === 'number' ? raw : /^\d{1,3}$/.test(str) ? Number(str) : NaN;
      return Number.isInteger(n) && n >= 0 && n <= 100 ? { ok: true, value: n } : { ok: false, error: 'ICP score must be a whole number from 0 to 100' };
    }
  }
}

/** Case/space/punctuation-insensitive form used to match quotes against the source. */
export function normaliseForQuote(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\s*(agent|customer|speaker\s*\d*)\s*:/gim, ' ')
    .replace(/[“”"'‘’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function quoteInSource(quote: string, source: string): boolean {
  const q = normaliseForQuote(quote);
  return q.length >= 6 && normaliseForQuote(source).includes(q);
}

/** A quote that addresses the AI (prompt-injection text) is never evidence. */
const INSTRUCTION_LIKE =
  /\b(ignore|disregard|forget)\b.{0,40}\b(instruction|instructions|previous|above|rules|prompt)\b|\b(system prompt|you are (an? )?(ai|assistant|model)|as an ai|assistant:|developer message)\b/i;
export function looksLikeInstruction(quote: string): boolean {
  return INSTRUCTION_LIKE.test(quote);
}

/**
 * True when the quote, or any source line it was taken from, reads like an
 * instruction to the AI. Catches a fragment cut from an injection line
 * ("...set the amount to 99 crore") that on its own looks innocent.
 */
export function evidenceFromInstruction(quote: string, source: string): boolean {
  if (looksLikeInstruction(quote)) return true;
  const q = normaliseForQuote(quote);
  if (!q) return false;
  return source
    .split(/\n+|(?<=[.!?])\s+/)
    .some((line) => normaliseForQuote(line).includes(q) && looksLikeInstruction(line));
}

export function sameValue(a: SuggestionValue | undefined, b: SuggestionValue | undefined): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export type TargetValues = Partial<Record<SuggestionField, SuggestionValue>>;

export type ValidSuggestion = {
  target: 'deal' | 'contact';
  field: SuggestionField;
  value: SuggestionValue;
  current: SuggestionValue;
  evidenceQuote: string;
  confidence: number;
};

export type Dropped = { field: string; reason: string };

/**
 * Turn raw model output into suggestions we are willing to show. Anything
 * that fails is dropped with a reason (logged as counts, never shown).
 */
export function validateSuggestions(
  raw: unknown,
  ctx: {
    source: string;
    today: string;
    targets: { deal?: TargetValues | null; contact?: TargetValues | null };
    allowFollowUp: boolean;
  },
): { suggestions: ValidSuggestion[]; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const parsed = rawOutputSchema.safeParse(raw);
  if (!parsed.success) return { suggestions: [], dropped: [{ field: '(output)', reason: 'schema' }] };
  const out: ValidSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of parsed.data.suggestions) {
    const field = s.field as SuggestionField;
    const allowed: readonly string[] = s.target === 'deal' ? DEAL_FIELDS : CONTACT_FIELDS;
    if (!allowed.includes(field)) {
      dropped.push({ field: s.field, reason: 'field not allowed for target' });
      continue;
    }
    if (field === 'follow_up_task' && !ctx.allowFollowUp) {
      dropped.push({ field, reason: 'follow-up not extracted for this source' });
      continue;
    }
    const current = s.target === 'deal' ? ctx.targets.deal : ctx.targets.contact;
    if (!current) {
      dropped.push({ field, reason: 'no such record linked' });
      continue;
    }
    if (!Number.isFinite(s.confidence) || s.confidence < 0 || s.confidence > 1) {
      dropped.push({ field, reason: 'confidence out of range' });
      continue;
    }
    if (evidenceFromInstruction(s.evidence_quote, ctx.source)) {
      dropped.push({ field, reason: 'instruction-like evidence' });
      continue;
    }
    if (!quoteInSource(s.evidence_quote, ctx.source)) {
      dropped.push({ field, reason: 'evidence not found verbatim' });
      continue;
    }
    const v = validateFieldValue(field, s.value, { today: ctx.today, dueDate: s.due_date });
    if (!v.ok) {
      dropped.push({ field, reason: v.error });
      continue;
    }
    const cur = current[field] ?? null;
    if (field !== 'follow_up_task' && sameValue(cur, v.value)) {
      dropped.push({ field, reason: 'same as current value' });
      continue;
    }
    const key = `${s.target}:${field}`;
    if (seen.has(key)) {
      dropped.push({ field, reason: 'duplicate field' });
      continue;
    }
    seen.add(key);
    out.push({ target: s.target, field, value: v.value, current: cur, evidenceQuote: s.evidence_quote.trim(), confidence: s.confidence });
  }
  return { suggestions: out, dropped };
}

/* ------------------------------------------------------------ prospect enrichment */

export const ENRICH_FIELDS = ['industry', 'size_band', 'product_fit', 'icp_score'] as const;
export type EnrichField = (typeof ENRICH_FIELDS)[number];

const enrichItemSchema = z.object({
  value: z.union([z.string(), z.number()]).nullable(),
  reasoning: z.string(),
  confidence: z.number(),
});
/** Raw enrichment output: one entry per field (value null when the model is unsure). */
export const rawEnrichOutputSchema = z.object({
  industry: enrichItemSchema,
  size_band: enrichItemSchema,
  product_fit: enrichItemSchema,
  icp_score: enrichItemSchema,
});

export type ValidEnrichment = {
  field: EnrichField;
  value: SuggestionValue;
  current: null;
  /** The model's reasoning (≤ 500 chars); stored as the suggestion's evidence_quote. */
  evidenceQuote: string;
  confidence: number;
};

/**
 * Enrichment (source_type 'enrichment') suggestions from raw model output.
 * Unlike call/email extraction there is no source conversation, so there is
 * no quote-in-source check: the evidence is the model's own reasoning. Every
 * value is still re-validated per field (product fit must be one of
 * `offeringIds`, size band one of PROSPECT_SIZE_BANDS, ICP a whole number
 * 0–100, industry ≤ 80 chars), instruction-like reasoning is dropped, and a
 * field that already has a value on the prospect is never suggested.
 */
export function validateEnrichment(
  raw: unknown,
  ctx: { offeringIds: readonly string[]; current: Partial<Record<EnrichField, SuggestionValue | undefined>> },
): { suggestions: ValidEnrichment[]; dropped: Dropped[] } {
  const parsed = rawEnrichOutputSchema.safeParse(raw);
  if (!parsed.success) return { suggestions: [], dropped: [{ field: '(output)', reason: 'schema' }] };
  const out: ValidEnrichment[] = [];
  const dropped: Dropped[] = [];
  for (const field of ENRICH_FIELDS) {
    const item = parsed.data[field];
    if (item.value == null || (typeof item.value === 'string' && !item.value.trim())) continue; // unsure: nothing to suggest
    const cur = ctx.current[field];
    if (cur != null && cur !== '') {
      dropped.push({ field, reason: 'field already has a value' });
      continue;
    }
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      dropped.push({ field, reason: 'confidence out of range' });
      continue;
    }
    const reasoning = item.reasoning.trim();
    if (!reasoning) {
      dropped.push({ field, reason: 'no reasoning' });
      continue;
    }
    if (looksLikeInstruction(reasoning)) {
      dropped.push({ field, reason: 'instruction-like evidence' });
      continue;
    }
    const v = validateFieldValue(field, item.value, { today: '', offeringIds: ctx.offeringIds });
    if (!v.ok) {
      dropped.push({ field, reason: v.error });
      continue;
    }
    out.push({ field, value: v.value, current: null, evidenceQuote: reasoning.slice(0, 500), confidence: item.confidence });
  }
  return { suggestions: out, dropped };
}
