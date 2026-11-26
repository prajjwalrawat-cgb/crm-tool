import { type NextRequest } from 'next/server';

import { withFieldActor } from '@/app/api/field/_lib/actor';
import { parseWalkInBody, readJson } from '@/app/api/field/_lib/http';
import { walkIn } from '@/lib/field/checkins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/field/meetings/walk-in - {lat,lng,accuracyM,title?,dealId?,companyId?,contactId?,notes?}. 200 Meeting. */
export function POST(req: NextRequest): Promise<Response> {
  return withFieldActor(async (actor) => walkIn(actor, parseWalkInBody(await readJson(req))));
}
