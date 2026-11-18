import { NextResponse } from 'next/server';

import { claimNextItem } from '@/lib/telephony/campaigns';
import { withViewer } from '@/lib/telephony/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/campaigns/:id/next — the agent pulls their next lead. Claims one
 * pending item atomically (FOR UPDATE SKIP LOCKED); returns the same item if
 * the agent already holds one. 204 when the queue is empty.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withViewer(async (viewer) => {
    const next = await claimNextItem({ tenantId: viewer.tenantId, campaignId: id, agentUserId: viewer.userId });
    if (!next) return new Response(null, { status: 204 });
    return NextResponse.json(next);
  });
}
