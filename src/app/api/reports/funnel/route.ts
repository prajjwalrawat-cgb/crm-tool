import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { funnel, funnelDrill, resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RangeQuery = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compareTo: z.enum(['previous', 'yoy', 'none']).optional(),
});

const Q = RangeQuery.extend({
  sourceId: z.union([z.uuid(), z.literal('none')]).optional(),
  ownerId: z.string().max(100).optional(),
  // No teams yet: team scope comes from the reporting line (scopeUsers).
  teamId: z.string().optional(),
  drillStage: z.enum(['lead', 'qualified', 'proposal', 'negotiation', 'won']).optional(),
});

/** GET /api/reports/funnel?from&to&sourceId&ownerId[&drillStage=] — cohort funnel, or the leads behind one bar. */
export async function GET(req: Request) {
  return withReportSession(async ({ tenant, scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    const { range } = await resolveForTenant(tenant.id, { ...q.data, range: q.data.range ?? (q.data.from ? 'custom' : undefined) });
    const filters = { sourceId: q.data.sourceId ?? null, ownerId: q.data.ownerId ?? null };
    if (q.data.drillStage) return json({ range, stage: q.data.drillStage, rows: await funnelDrill(scope, range, q.data.drillStage, filters) });
    return json(await funnel(scope, range, filters));
  });
}
