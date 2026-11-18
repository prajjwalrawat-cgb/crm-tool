import { z } from 'zod';

import { EXPORT_REPORTS, exportCsvStream } from '@/lib/reports/manager/export';
import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q = z.object({
  report: z.enum(EXPORT_REPORTS),
  // xlsx is not offered (no spreadsheet library); CSV opens in Excel.
  format: z.literal('csv').default('csv'),
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.string().regex(/^\d{1,3}$/).optional(),
  ownerId: z.string().max(100).optional(),
});

/** GET /api/reports/export?report=…&format=csv — streamed, 100k row cap, audit-logged. */
export async function GET(req: Request) {
  return withReportSession(async ({ tenant, scope, run }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    const { range } = await resolveForTenant(tenant.id, { ...q.data, range: q.data.range ?? (q.data.from ? 'custom' : undefined) });
    const params: Record<string, string> = {};
    if (q.data.days) params.days = q.data.days;
    if (q.data.ownerId) params.ownerId = q.data.ownerId;
    const stream = exportCsvStream({ scope, report: q.data.report, range, params, run });
    const file = `${q.data.report.replace(':', '-')}_${range.fromDay}_${range.toDay}.csv`;
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
