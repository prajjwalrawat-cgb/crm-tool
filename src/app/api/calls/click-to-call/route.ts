import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { clickToCall } from '@/lib/telephony/service';
import { withViewer } from '@/lib/telephony/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    leadId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    phone: z.string().min(6).max(40).optional(),
    overrideHours: z.boolean().optional(),
  })
  .refine((b) => b.leadId || b.contactId || b.phone, { message: 'leadId, contactId or phone is required' });

/** POST /api/calls/click-to-call {leadId|contactId|phone} → {callId} */
export async function POST(request: NextRequest) {
  return withViewer(async (viewer) => {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body', message: parsed.error.issues[0]?.message }, { status: 400 });
    const { callId } = await clickToCall({ ...viewer, ...parsed.data });
    return NextResponse.json({ callId }, { status: 201 });
  });
}
