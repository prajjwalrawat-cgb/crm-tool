import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId, parsePositionBody, readJson } from '@/app/api/field/_lib/http';
import { checkOut } from '@/lib/field/checkins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/checkout - {lat,lng,accuracyM}. 200 {checkin,verified,distanceM}. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return checkOut(actor, id, parsePositionBody(await readJson(req)));
  });
}
