import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId, parseUpdateBody, readJson } from '@/app/api/field/_lib/http';
import { updateMeeting } from '@/lib/field/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH /api/field/meetings/:id - partial CreateMeetingInput. 200 Meeting. */
export function PATCH(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return updateMeeting(actor, id, parseUpdateBody(await readJson(req)));
  });
}
