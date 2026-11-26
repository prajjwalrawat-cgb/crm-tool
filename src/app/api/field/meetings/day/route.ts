import { type NextRequest } from 'next/server';

import { withFieldActor } from '@/app/api/field/_lib/actor';
import { parseDayQuery } from '@/app/api/field/_lib/http';
import { getDay } from '@/lib/field/day';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/field/meetings/day?date=YYYY-MM-DD&repId=&atRiskOnly= - 200 DayView. */
export function GET(req: NextRequest): Promise<Response> {
  return withFieldActor(async (actor) => getDay(actor, parseDayQuery(req.nextUrl.searchParams)));
}
