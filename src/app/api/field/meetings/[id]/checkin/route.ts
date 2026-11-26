import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseCheckInBody, parseMeetingId, readJson } from '@/app/api/field/_lib/http';
import { checkIn } from '@/lib/field/checkins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/checkin - {lat,lng,accuracyM,overrideReason?}. 200 {checkin,verified,distanceM}; 422 outside_radius {distanceM,radiusM}. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return checkIn(actor, id, parseCheckInBody(await readJson(req)));
  });
}
