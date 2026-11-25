import { type NextRequest } from 'next/server';

import { withFieldActor } from '@/app/api/field/_lib/actor';
import { parseCreateBody, readJson } from '@/app/api/field/_lib/http';
import { createMeeting } from '@/lib/field/meetings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings - CreateMeetingInput body (dates ISO). 200 Meeting. */
export function POST(req: NextRequest): Promise<Response> {
  return withFieldActor(async (actor) => createMeeting(actor, parseCreateBody(await readJson(req))));
}
