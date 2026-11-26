import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId, parsePositionBody, readJson } from '@/app/api/field/_lib/http';
import { verifyLocation } from '@/lib/field/checkins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/verify - {lat,lng,accuracyM}. 200 {checkin,verified,distanceM}; 422 outside_radius {distanceM,radiusM}. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return verifyLocation(actor, id, parsePositionBody(await readJson(req)));
  });
}
