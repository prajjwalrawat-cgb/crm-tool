import { type NextRequest } from 'next/server';

import { withFieldActor, type IdCtx } from '@/app/api/field/_lib/actor';
import { parseMeetingId } from '@/app/api/field/_lib/http';
import { markEnRoute } from '@/lib/field/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/:id/en-route - no body. 200 Meeting. */
export function POST(_req: NextRequest, ctx: IdCtx): Promise<Response> {
  return withFieldActor(async (actor) => {
    const id = parseMeetingId((await ctx.params).id);
    return markEnRoute(actor, id);
  });
}
