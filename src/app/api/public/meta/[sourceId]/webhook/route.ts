import { createHmac, timingSafeEqual } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { getLeadSource } from '@/lib/lead-capture/admin';
import { runWithSystemContext } from '@/lib/db-context';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { lookupSourceForPublic, receiveIngestEvent } from '@/lib/lead-capture/ingest';
import { logger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Meta (Facebook/Instagram) Lead Ads webhook for one lead source.
 *
 * Setup (Meta app → Webhooks → Page → `leadgen`):
 *   Callback URL  https://<host>/api/public/meta/<sourceId>/webhook
 *   Verify token  the source's secret token
 * Env: META_APP_SECRET (signs deliveries, X-Hub-Signature-256),
 *      META_GRAPH_VERSION (default v21.0 — check Meta's changelog).
 * Source config: { page_id, form_ids?, page_token } — the page access token
 * is used to fetch the lead's field_data, since the webhook only carries ids.
 *
 * A failed Graph fetch returns 500 so Meta redelivers; nothing is stored
 * without the lead's fields.
 */

type Ctx = { params: Promise<{ sourceId: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  const { sourceId } = await ctx.params;
  const q = request.nextUrl.searchParams;
  const source = await lookupSourceForPublic(sourceId);
  if (!source || !source.isActive) return new NextResponse('not found', { status: 404 });
  const token = q.get('hub.verify_token') ?? '';
  const a = Buffer.from(token);
  const b = Buffer.from(source.secretToken);
  const ok = q.get('hub.mode') === 'subscribe' && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return new NextResponse('forbidden', { status: 403 });
  return new NextResponse(q.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

type LeadgenChange = { field?: string; value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; created_time?: number } };

export async function POST(request: NextRequest, ctx: Ctx) {
  const { sourceId } = await ctx.params;
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appSecret) {
    logger.error('meta webhook: META_APP_SECRET not set', { sourceId });
    return new NextResponse('not configured', { status: 503 });
  }
  const lookup = await lookupSourceForPublic(sourceId);
  if (!lookup || !lookup.isActive) return new NextResponse('not found', { status: 404 });

  const raw = await request.text();
  if (raw.length > 1024 * 1024) return new NextResponse('too large', { status: 413 });
  const given = (request.headers.get('x-hub-signature-256') ?? '').replace(/^sha256=/, '');
  const expected = createHmac('sha256', appSecret).update(raw, 'utf8').digest('hex');
  if (!/^[0-9a-f]{64}$/.test(given) || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return new NextResponse('invalid signature', { status: 401 });
  }

  let body: { object?: string; entry?: Array<{ changes?: LeadgenChange[] }> };
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse('invalid json', { status: 400 });
  }

  const source = await runWithSystemContext(lookup.tenantId, () => getLeadSource(lookup.tenantId, sourceId));
  const cfg = source?.config ?? {};
  if (!cfg.page_token) {
    logger.error('meta webhook: source has no page_token', { sourceId });
    return new NextResponse('source not configured', { status: 503 });
  }
  const version = process.env.META_GRAPH_VERSION?.trim() || 'v21.0';

  const changes = (body.entry ?? []).flatMap((e) => e.changes ?? []).filter((c) => c.field === 'leadgen' && c.value?.leadgen_id);
  for (const c of changes) {
    const v = c.value!;
    if (cfg.page_id && v.page_id && v.page_id !== cfg.page_id) continue;
    if (cfg.form_ids?.length && v.form_id && !cfg.form_ids.includes(v.form_id)) continue;
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(v.leadgen_id!)}?access_token=${encodeURIComponent(cfg.page_token)}`;
    let lead: { field_data?: unknown; created_time?: string; form_id?: string; ad_id?: string; campaign_name?: string };
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`graph ${res.status}`);
      lead = await res.json();
    } catch (err) {
      logger.error('meta webhook: graph fetch failed', { sourceId, reason: err instanceof Error ? err.message : 'error' });
      return new NextResponse('graph fetch failed', { status: 500 });
    }
    const payload = {
      field_data: lead.field_data ?? [],
      leadgen_id: v.leadgen_id,
      form_id: lead.form_id ?? v.form_id ?? null,
      page_id: v.page_id ?? null,
      ad_id: lead.ad_id ?? v.ad_id ?? null,
      created_time: lead.created_time ?? null,
      utm_source: 'facebook',
      utm_medium: 'paid_social',
      ...(lead.campaign_name ? { utm_campaign: lead.campaign_name } : {}),
    };
    const { eventId } = await receiveIngestEvent({ tenantId: lookup.tenantId, sourceId, payload });
    await sendWorkflowEvent('crm/lead.ingest_received', { tenantId: lookup.tenantId, eventId });
  }
  return NextResponse.json({ ok: true, received: changes.length });
}
