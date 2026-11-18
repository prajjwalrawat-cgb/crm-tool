import { z } from 'zod';

import type { CaptureFormField } from '@/db/schema/lead-capture';

/**
 * Pure form-submission rules (CORS decision, bot traps, consent, field
 * validation). No I/O, so the selftest exercises them directly.
 */

type FormShape = { fields: CaptureFormField[]; consentText: string | null; formId: string };

/**
 * CORS: the hosted page is same-origin and always allowed. A cross-origin
 * embed is allowed only from the source's configured `allowed_origins`.
 */
export function corsOrigin(requestOrigin: string | null, appOrigin: string, allowed: string[]): string | null {
  if (!requestOrigin) return null;
  if (requestOrigin === appOrigin) return requestOrigin;
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

export const formSubmissionSchema = z.object({
  fields: z.record(z.string().max(64), z.union([z.string().max(5000), z.boolean()])),
  consent: z.boolean().optional(),
  /** Honeypot: hidden input that humans leave empty. */
  hp: z.string().max(500).optional(),
  /** Epoch ms when the form was rendered (time trap). */
  t: z.number().int().optional(),
  utm: z
    .object({
      source: z.string().max(200).optional(),
      medium: z.string().max(200).optional(),
      campaign: z.string().max(200).optional(),
      term: z.string().max(200).optional(),
      content: z.string().max(200).optional(),
    })
    .optional(),
  landingUrl: z.string().max(2000).optional(),
  referrer: z.string().max(2000).optional(),
  captchaToken: z.string().max(4000).optional(),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

/** Submitted faster than a human could fill a form. */
export const MIN_FILL_MS = 2_000;

export type SubmissionCheck =
  | { kind: 'ok'; payload: Record<string, unknown> }
  | { kind: 'silent_drop'; reason: string }
  | { kind: 'invalid'; message: string; field?: string };

/** Pure validation of a submission against its form. */
export function checkSubmission(form: FormShape, s: FormSubmission, now = Date.now()): SubmissionCheck {
  if (s.hp && s.hp.trim() !== '') return { kind: 'silent_drop', reason: 'honeypot' };
  if (typeof s.t === 'number' && now - s.t < MIN_FILL_MS) return { kind: 'silent_drop', reason: 'too_fast' };
  if (form.consentText && s.consent !== true) {
    return { kind: 'invalid', message: 'Please accept the consent statement to continue.', field: 'consent' };
  }
  const payload: Record<string, unknown> = {};
  for (const f of form.fields) {
    const raw = s.fields[f.key];
    const v = typeof raw === 'boolean' ? raw : typeof raw === 'string' ? raw.trim() : undefined;
    if (f.required && (v === undefined || v === '' || v === false)) {
      return { kind: 'invalid', message: `${f.label} is required.`, field: f.key };
    }
    if (typeof v === 'string' && v !== '') {
      if (f.validation?.maxLength && v.length > f.validation.maxLength) {
        return { kind: 'invalid', message: `${f.label} is too long.`, field: f.key };
      }
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return { kind: 'invalid', message: `${f.label} must be a valid email.`, field: f.key };
      }
      if (f.type === 'select' && f.options?.length && !f.options.includes(v)) {
        return { kind: 'invalid', message: `Pick a valid ${f.label}.`, field: f.key };
      }
      if (f.validation?.pattern) {
        try {
          if (!new RegExp(f.validation.pattern).test(v)) return { kind: 'invalid', message: `${f.label} is not valid.`, field: f.key };
        } catch {
          /* a bad admin pattern never blocks a lead */
        }
      }
    }
    if (v !== undefined && v !== '') payload[f.key] = v;
  }
  if (s.consent !== undefined) payload.consent = s.consent;
  if (s.utm?.source) payload.utm_source = s.utm.source;
  if (s.utm?.medium) payload.utm_medium = s.utm.medium;
  if (s.utm?.campaign) payload.utm_campaign = s.utm.campaign;
  if (s.utm?.term) payload.utm_term = s.utm.term;
  if (s.utm?.content) payload.utm_content = s.utm.content;
  if (s.landingUrl) payload.landing_url = s.landingUrl;
  if (s.referrer) payload.referrer_url = s.referrer;
  payload.form_id = form.formId;
  return { kind: 'ok', payload };
}

