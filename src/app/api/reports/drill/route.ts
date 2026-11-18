import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { DRILL_METRICS, drill, resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compareTo: z.enum(['previous', 'yoy', 'none']).optional(),
});

const Q = RangeQuery.extend({ metric: z.enum(DRILL_METRICS) });

/** GET /api/reports/drill?metric=&range… — the rows behind a KPI tile; count/sum reconcile with the tile. */
export async function GET(req: Request) {
  return withReportSession(async ({ tenant, scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    const { range } = await resolveForTenant(tenant.id, q.data);
    return json(await drill(scope, q.data.metric, range));
  });
}
