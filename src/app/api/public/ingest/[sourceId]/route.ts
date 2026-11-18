import { NextResponse, type NextRequest } from 'next/server';

import { sendWorkflowEvent } from '@/lib/inngest/send';
import { lookupSourceForPublic, receiveIngestEvent } from '@/lib/lead-capture/ingest';
import { clientIpBucket, rateLimitHit } from '@/lib/lead-capture/rate-limit';
import { verifyIngestAuth } from '@/lib/lead-capture/signature';
import { logger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/public/ingest/:sourceId — inbound leads from webhooks, portals,
 * ad platforms and custom integrations. No session; authenticated per source:
 *
 *   X-Saleinx-Token: <source secret>                  or
 *   X-Saleinx-Signature: sha256=<HMAC-SHA256(raw body, source secret)>
 *
 * Body: JSON object, or application/x-www-form-urlencoded. Max 1 MB.
 * Rate limits: 60/min per client IP, 600/min per source.
 *
 * The payload is stored before anything else and processed asynchronously,
 * so the response is 202 { eventId } as soon as it is safely persisted. The
 * same payload replayed within 24h returns the same eventId and creates
 * nothing new.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const IP_LIMIT_PER_MIN = 60;
const SOURCE_LIMIT_PER_MIN = 600;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });

export async function POST(request: NextRequest, ctx: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = await ctx.params;

  if (!(await rateLimitHit(`ingest:ip:${clientIpBucket(request.headers)}`, IP_LIMIT_PER_MIN))) {
    return json(429, { error: 'rate_limited' });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });

  const source = await lookupSourceForPublic(sourceId);
  // Unknown and inactive sources look the same from outside.
  if (!source || !source.isActive) return json(404, { error: 'unknown_source' });

  if (!(await rateLimitHit(`ingest:src:${sourceId}`, SOURCE_LIMIT_PER_MIN))) {
    return json(429, { error: 'rate_limited' });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' });

  const authed = verifyIngestAuth({
    rawBody,
    secret: source.secretToken,
    tokenHeader: request.headers.get('x-saleinx-token'),
    signatureHeader: request.headers.get('x-saleinx-signature'),
  });
  if (!authed) {
    logger.warn('lead ingest auth failed', { sourceId });
    return json(401, { error: 'invalid_signature' });
  }

  let payload: unknown;
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded')) {
      payload = Object.fromEntries(new URLSearchParams(rawBody));
    } else {
      payload = JSON.parse(rawBody);
    }
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json(400, { error: 'body_must_be_an_object' });
  }

  const { eventId, replay } = await receiveIngestEvent({ tenantId: source.tenantId, sourceId, payload });
  // Sent on replays too: processing is idempotent and Inngest dedupes on
  // eventId, so a replay after a lost first send still gets processed.
  await sendWorkflowEvent('crm/lead.ingest_received', { tenantId: source.tenantId, eventId });

  logger.info('lead ingest received', { tenantId: source.tenantId, sourceId, eventId, replay });
  return json(202, { eventId, replay });
}
