import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { staleLeads } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q = z.object({ days: z.coerce.number().int().min(1).max(365).default(7), ownerId: z.string().max(100).optional() });

/** GET /api/reports/stale-leads?days=7&ownerId= — actionable list. */
export async function GET(req: Request) {
  return withReportSession(async ({ scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    return json(await staleLeads(scope, q.data.days, q.data.ownerId ?? null));
  });
}
