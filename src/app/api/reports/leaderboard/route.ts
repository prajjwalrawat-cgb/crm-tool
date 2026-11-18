import { z } from 'zod';

import { json, queryOf, withReportSession } from '@/lib/reports/manager/http';
import { LEADERBOARD_METRICS, LEADERBOARD_PERIODS, leaderboard } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Q = z.object({
  metric: z.enum(LEADERBOARD_METRICS).default('won_value'),
  period: z.enum(LEADERBOARD_PERIODS).default('month'),
});

/** GET /api/reports/leaderboard?metric=won_value|calls|qualified&period=today|week|month — live, cached 30s. */
export async function GET(req: Request) {
  return withReportSession(async ({ scope }) => {
    const q = Q.safeParse(queryOf(req));
    if (!q.success) return json({ error: 'invalid_query', issues: q.error.issues }, { status: 400 });
    return json(await leaderboard(scope, q.data.metric, q.data.period), { cacheSeconds: 30 });
  });
}
