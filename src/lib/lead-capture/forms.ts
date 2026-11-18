import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/db';
import type { CaptureFormField } from '@/db/schema';

export { checkSubmission, corsOrigin, formSubmissionSchema, MIN_FILL_MS, type FormSubmission, type SubmissionCheck } from './form-submission';

/**
 * Hosted / embedded capture forms: public lookup, CORS policy and submission
 * validation. The submit itself goes through the normal ingest path.
 */

export type PublicForm = {
  tenantId: string;
  formId: string;
  sourceId: string;
  title: string;
  fields: CaptureFormField[];
  thankYouMessage: string | null;
  redirectUrl: string | null;
  consentText: string | null;
  theme: Record<string, unknown>;
  allowedOrigins: string[];
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function lookupPublicForm(tenantSlug: string, formSlug: string): Promise<PublicForm | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/i.test(tenantSlug) || !SLUG.test(formSlug)) return null;
  const rows = await db.execute<{
    tenant_id: string;
    form_id: string;
    source_id: string;
    title: string;
    fields: CaptureFormField[];
    thank_you_message: string | null;
    redirect_url: string | null;
    consent_text: string | null;
    theme: Record<string, unknown> | null;
    allowed_origins: string[] | null;
  }>(sql`select * from capture_form_public_lookup(${tenantSlug}, ${formSlug})`);
  const r = rows[0];
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    formId: r.form_id,
    sourceId: r.source_id,
    title: r.title,
    fields: r.fields ?? [],
    thankYouMessage: r.thank_you_message,
    redirectUrl: r.redirect_url,
    consentText: r.consent_text,
    theme: r.theme ?? {},
    allowedOrigins: r.allowed_origins ?? [],
  };
}

/** The definition the embed renders. Nothing tenant-internal leaks. */
export function publicFormDefinition(f: PublicForm) {
  return {
    title: f.title,
    fields: f.fields.map((x) => ({
      key: x.key,
      label: x.label,
      type: x.type,
      required: !!x.required,
      options: x.options ?? [],
      maxLength: x.validation?.maxLength ?? null,
    })),
    consentText: f.consentText,
    thankYouMessage: f.thankYouMessage ?? 'Thank you — we will be in touch shortly.',
    hasRedirect: !!f.redirectUrl,
    theme: { accent: typeof f.theme.accent === 'string' ? f.theme.accent : '#4f46e5' },
    captchaSiteKey: process.env.TURNSTILE_SITE_KEY?.trim() || null,
  };
}

/** Cloudflare Turnstile verification, only when TURNSTILE_SECRET_KEY is set. */
export async function verifyCaptcha(token: string | undefined, ip: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
