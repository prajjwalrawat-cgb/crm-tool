import { NextResponse, type NextRequest } from 'next/server';

import { TELEPHONY_PROVIDERS, type TelephonyProviderName } from '@/db/schema';
import { runWithSystemContext, tenantTransaction } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { rateLimitHit } from '@/lib/lead-capture/rate-limit';
import { logger } from '@/lib/observability';
import { getAccountRow, lookupAccountForWebhook, toAccountContext } from '@/lib/telephony/accounts';
import { getProvider } from '@/lib/telephony/providers';
import { NotImplementedError } from '@/lib/telephony/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Provider webhooks: status callbacks (outbound) and Passthru hits (inbound).
 *   GET|POST /api/public/telephony/:provider/:accountId/webhook?s=<webhook secret>
 *
 * Verify → normalize → enqueue `crm/call.event_received` → 200, fast. All
 * real work happens in the workflow, which is idempotent and order-safe.
 * Unknown payload shapes are acknowledged (200) and ignored, so the provider
 * does not retry them forever.
 */

const MAX_BODY_BYTES = 256 * 1024;
const ok = (body: Record<string, unknown> = { ok: true }) => NextResponse.json(body, { status: 200 });

async function handle(request: NextRequest, ctx: { params: Promise<{ provider: string; accountId: string }> }) {
  const { provider, accountId } = await ctx.params;
  if (!(TELEPHONY_PROVIDERS as readonly string[]).includes(provider)) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 });
  }
  if (!(await rateLimitHit(`telephony:acct:${accountId}`, 1200))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  const found = await lookupAccountForWebhook(accountId);
  if (!found || !found.isActive || found.provider !== provider) {
    return NextResponse.json({ error: 'unknown_account' }, { status: 404 });
  }

  const rawBody = request.method === 'GET' ? '' : await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const account = await runWithSystemContext(found.tenantId, () =>
    tenantTransaction((tx) => getAccountRow(tx, found.tenantId, accountId)),
  );
  if (!account) return NextResponse.json({ error: 'unknown_account' }, { status: 404 });
  const accountCtx = toAccountContext(account);
  const adapter = getProvider(provider as TelephonyProviderName);

  let verified = false;
  try {
    verified = adapter.verifyWebhook(
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        rawBody,
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      },
      accountCtx,
    );
  } catch (err) {
    if (err instanceof NotImplementedError) return NextResponse.json({ error: 'provider_not_supported' }, { status: 501 });
    throw err;
  }
  if (!verified) {
    logger.warn('telephony webhook rejected', { accountId });
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  // JSON, form-encoded or query-string: providers (and applet versions) differ.
  const params = Object.fromEntries(new URL(request.url).searchParams);
  delete params.s;
  let body: unknown = params;
  const type = request.headers.get('content-type') ?? '';
  if (rawBody) {
    try {
      body = type.includes('application/x-www-form-urlencoded')
        ? { ...params, ...Object.fromEntries(new URLSearchParams(rawBody)) }
        : { ...params, ...(JSON.parse(rawBody) as Record<string, unknown>) };
    } catch {
      body = { ...params, ...Object.fromEntries(new URLSearchParams(rawBody)) };
    }
  }

  const event = adapter.parseWebhook(body);
  if (!event) return ok({ ok: true, ignored: true });

  await sendWorkflowEvent('crm/call.event_received', {
    tenantId: found.tenantId,
    accountId,
    provider,
    event: {
      ...event,
      startedAt: event.startedAt?.toISOString() ?? null,
      answeredAt: event.answeredAt?.toISOString() ?? null,
      endedAt: event.endedAt?.toISOString() ?? null,
    },
  });
  return ok();
}

export const GET = handle;
export const POST = handle;
