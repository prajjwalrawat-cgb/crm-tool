import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId, parseSiteBody, readJson } from '@/app/api/field/_lib/http';
import { pinMeetingSite } from '@/lib/field/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/site - {input} (address, lat,lng or maps link). 200 Meeting. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return pinMeetingSite(actor, id, parseSiteBody(await readJson(req)).input);
  });
}
