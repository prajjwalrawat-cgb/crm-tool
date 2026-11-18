import { NextResponse, type NextRequest } from 'next/server';

import { corsOrigin, lookupPublicForm, publicFormDefinition } from '@/lib/lead-capture/forms';
import { clientIpBucket, rateLimitHit } from '@/lib/lead-capture/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ tenantSlug: string; formSlug: string }> };

/** GET /api/public/forms/:tenantSlug/:formSlug — form definition for the embed. */
export async function GET(request: NextRequest, ctx: Ctx) {
  const { tenantSlug, formSlug } = await ctx.params;
  if (!(await rateLimitHit(`form-def:ip:${clientIpBucket(request.headers)}`, 120))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
  const form = await lookupPublicForm(tenantSlug, formSlug);
  if (!form) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const origin = corsOrigin(request.headers.get('origin'), request.nextUrl.origin, form.allowedOrigins);
  const res = NextResponse.json(publicFormDefinition(form));
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Vary', 'Origin');
  }
  res.headers.set('Cache-Control', 'public, max-age=60');
  return res;
}
