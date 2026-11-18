import { NextResponse, type NextRequest } from 'next/server';

import { serializeCall } from '@/lib/telephony/serialize';
import { listCallsScoped } from '@/lib/telephony/service';
import { withViewer } from '@/lib/telephony/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/calls?leadId=&userId=&from=&to=&direction=&status=&limit=
 * Reps see their own calls; managers/admins/owners see the workspace.
 * Responses go through serializeCall — no recording URL or storage key.
 */
export async function GET(request: NextRequest) {
  return withViewer(async (viewer) => {
    const q = request.nextUrl.searchParams;
    const date = (k: string) => {
      const v = q.get(k);
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    };
    const direction = q.get('direction');
    const rows = await listCallsScoped({
      tenantId: viewer.tenantId,
      viewer,
      leadId: q.get('leadId'),
      userId: q.get('userId'),
      from: date('from'),
      to: date('to'),
      direction: direction === 'inbound' || direction === 'outbound' ? direction : null,
      status: q.get('status'),
      limit: Number(q.get('limit') ?? 100) || 100,
    });
    return NextResponse.json({ calls: rows.map((r) => serializeCall(r)) });
  });
}
