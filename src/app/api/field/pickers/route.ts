import { type NextRequest } from 'next/server';

import { withFieldActor } from '@/app/api/field/_lib/actor';
import { parsePickerQuery } from '@/app/api/field/_lib/http';
import { listPickerOptions } from '@/lib/field/pickers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/field/pickers?kind=deal|company|contact&q=&companyId= - 200 PickerResponse.
 * Up to 20 records the caller can see (the CRM's own visibility rule), most recently updated first.
 */
export function GET(req: NextRequest): Promise<Response> {
  return withFieldActor(async (actor) => listPickerOptions(actor, parsePickerQuery(req.nextUrl.searchParams)));
}
