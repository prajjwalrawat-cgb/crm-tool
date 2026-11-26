import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseCancelBody, parseMeetingId, readJson } from '@/app/api/field/_lib/http';
import { cancelMeeting } from '@/lib/field/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/cancel - {reason?}. 200 Meeting. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return cancelMeeting(actor, id, parseCancelBody(await readJson(req)).reason);
  });
}
