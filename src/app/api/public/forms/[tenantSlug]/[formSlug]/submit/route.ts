import { NextResponse, type NextRequest } from 'next/server';

import { sendWorkflowEvent } from '@/lib/inngest/send';
import {
  checkSubmission,
  corsOrigin,
  formSubmissionSchema,
  lookupPublicForm,
  verifyCaptcha,
} from '@/lib/lead-capture/forms';
import { receiveIngestEvent } from '@/lib/lead-capture/ingest';
import { clientIpBucket, rateLimitHit } from '@/lib/lead-capture/rate-limit';
import { logger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ tenantSlug: string; formSlug: string }> };

const MAX_BODY = 64 * 1024;

function withCors(res: NextResponse, origin: string | null): NextResponse {
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    res.headers.set('Vary', 'Origin');
  }
  return res;
}

export async function OPTIONS(request: NextRequest, ctx: Ctx) {
  const { tenantSlug, formSlug } = await ctx.params;
  const form = await lookupPublicForm(tenantSlug, formSlug);
  const origin = form ? corsOrigin(request.headers.get('origin'), request.nextUrl.origin, form.allowedOrigins) : null;
  return withCors(new NextResponse(null, { status: origin ? 204 : 403 }), origin);
}

/**
 * POST /api/public/forms/:tenantSlug/:formSlug/submit — hosted/embedded form
 * submission. Bot defences: honeypot field, minimum fill time, per-IP rate
 * limit (20/min), optional Cloudflare Turnstile. A bot that trips the
 * honeypot or time trap gets a normal-looking success and nothing is stored.
 * Cross-origin submits are accepted only from the source's allowed origins.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  const { tenantSlug, formSlug } = await ctx.params;
  const ipBucket = clientIpBucket(request.headers);
  if (!(await rateLimitHit(`form-submit:ip:${ipBucket}`, 20))) {
    return NextResponse.json({ error: 'rate_limited', message: 'Too many submissions. Try again in a minute.' }, { status: 429 });
  }

  const form = await lookupPublicForm(tenantSlug, formSlug);
  if (!form) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const reqOrigin = request.headers.get('origin');
  const origin = corsOrigin(reqOrigin, request.nextUrl.origin, form.allowedOrigins);
  if (reqOrigin && !origin) {
    return NextResponse.json({ error: 'origin_not_allowed' }, { status: 403 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return withCors(NextResponse.json({ error: 'payload_too_large' }, { status: 413 }), origin);
  let parsed;
  try {
    parsed = formSubmissionSchema.safeParse(JSON.parse(raw));
  } catch {
    return withCors(NextResponse.json({ error: 'invalid_json' }, { status: 400 }), origin);
  }
  if (!parsed.success) return withCors(NextResponse.json({ error: 'invalid_body' }, { status: 400 }), origin);

  const thanks = {
    ok: true,
    message: form.thankYouMessage ?? 'Thank you — we will be in touch shortly.',
    redirectUrl: form.redirectUrl,
  };

  const check = checkSubmission(form, parsed.data);
  if (check.kind === 'silent_drop') {
    logger.info('form submission dropped', { formId: form.formId, reason: check.reason });
    return withCors(NextResponse.json(thanks), origin);
  }
  if (check.kind === 'invalid') {
    return withCors(NextResponse.json({ error: 'invalid', message: check.message, field: check.field }, { status: 400 }), origin);
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  if (!(await verifyCaptcha(parsed.data.captchaToken, ip))) {
    return withCors(NextResponse.json({ error: 'captcha_failed', message: 'Please complete the verification.' }, { status: 400 }), origin);
  }

  const { eventId } = await receiveIngestEvent({ tenantId: form.tenantId, sourceId: form.sourceId, payload: check.payload });
  await sendWorkflowEvent('crm/lead.ingest_received', { tenantId: form.tenantId, eventId });
  logger.info('form submission received', { tenantId: form.tenantId, formId: form.formId, eventId });
  return withCors(NextResponse.json(thanks), origin);
}
