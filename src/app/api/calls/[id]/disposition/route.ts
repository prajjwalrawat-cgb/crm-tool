import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { CALL_DISPOSITIONS } from '@/db/schema';
import { saveDisposition } from '@/lib/telephony/service';
import { withViewer } from '@/lib/telephony/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  disposition: z.enum(CALL_DISPOSITIONS),
  notes: z.string().max(5000).nullish(),
  callbackAt: z.string().datetime({ offset: true }).nullish(),
});

/** POST /api/calls/:id/disposition {disposition, notes?, callbackAt?} */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withViewer(async (viewer) => {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body', message: parsed.error.issues[0]?.message }, { status: 400 });
    const r = await saveDisposition({
      ...viewer,
      callId: id,
      disposition: parsed.data.disposition,
      notes: parsed.data.notes ?? null,
      callbackAt: parsed.data.callbackAt ? new Date(parsed.data.callbackAt) : null,
    });
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: 'rejected', message: r.error }, { status: 409 });
  });
}
