import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { summary, resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compareTo: z.enum(['previous', 'yoy', 'none']).optional(),
});

/** GET /api/reports/summary?range=today|7d|30d|mtd|custom&from&to&compareTo=previous|yoy|none */
export async function GET(req: Request) {
  return withReportSession(async ({ tenant, scope }) => {
    const q = RangeQuery.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    const { range, compare } = await resolveForTenant(tenant.id, q.data);
    return json(await summary(scope, range, compare));
  });
}
