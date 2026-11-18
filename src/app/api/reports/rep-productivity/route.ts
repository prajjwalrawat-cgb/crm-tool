import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { repDetail, repProductivity, resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compareTo: z.enum(['previous', 'yoy', 'none']).optional(),
});

const Q = RangeQuery.extend({ teamId: z.string().optional(), userId: z.string().max(100).optional() });

/** GET /api/reports/rep-productivity?from&to[&userId=] — the team table, or one rep's drill page. */
export async function GET(req: Request) {
  return withReportSession(async ({ tenant, scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    const { range } = await resolveForTenant(tenant.id, { ...q.data, range: q.data.range ?? (q.data.from ? 'custom' : undefined) });
    if (q.data.userId) {
      const detail = await repDetail(scope, range, q.data.userId);
      return detail ? json(detail) : json({ error: 'not_found' }, { status: 404 });
    }
    return json(await repProductivity(scope, range));
  });
}
