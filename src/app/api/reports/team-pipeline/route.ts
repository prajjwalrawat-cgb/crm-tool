import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { teamPipeline } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q = z.object({ teamId: z.string().optional(), staleDays: z.coerce.number().int().min(1).max(365).default(7) });

/** GET /api/reports/team-pipeline?staleDays=7 — open deals per stage per rep (read-only). */
export async function GET(req: Request) {
  return withReportSession(async ({ scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    return json(await teamPipeline(scope, q.data.staleDays));
  });
}
