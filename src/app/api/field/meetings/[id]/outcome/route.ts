import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId, parseOutcomeBody, readJson } from '@/app/api/field/_lib/http';
import { saveOutcome } from '@/lib/field/outcomes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/outcome - {momText,sentiment?,nextSteps?,checkOutAt?}. 200 MeetingOutcome. */
export function POST(req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return saveOutcome(actor, id, parseOutcomeBody(await readJson(req)));
  });
}
