import { NextResponse, type NextRequest } from 'next/server';

import { UUID_RE, withApiPermission } from '@/lib/lead-capture/api-auth';
import { reassignLead } from '@/lib/lead-capture/sla';
import { reassignInputSchema } from '@/lib/lead-capture/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/leads/:id/reassign  { "to": "<userId>", "reason": "…" } */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withApiPermission('assignLeads', async ({ tenantId, userId }) => {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
    const parsed = reassignInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid', issues: parsed.error.issues }, { status: 400 });
    const r = await reassignLead({ tenantId, dealId: id, toUserId: parsed.data.to, actorUserId: userId, reason: parsed.data.reason });
    if (!r.ok) return NextResponse.json({ error: 'not_reassigned', message: r.error }, { status: 404 });
    return NextResponse.json({ ok: true, assignmentId: r.assignmentId });
  });
}
