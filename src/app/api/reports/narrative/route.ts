import { z } from 'zod';

import { json, withReportSession } from '@/lib/reports/manager/http';
import { generateNarrative } from '@/lib/reports/manager/narrative';
import { resolveForTenant } from '@/lib/reports/manager/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  range: z.enum(['today', '7d', '30d', 'mtd', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  compareTo: z.enum(['previous', 'yoy']).optional(),
  /** "Regenerate": skip the 30-minute cache. */
  force: z.boolean().optional(),
});

/** POST /api/reports/narrative — AI "what changed and why" over aggregates only. */
export async function POST(req: Request) {
  return withReportSession(async ({ tenant, scope }) => {
    let raw: unknown = {};
    try {
      raw = await req.json();
    } catch {
      raw = {};
    }
    const b = Body.safeParse(raw);
    if (!b.success) return json({ error: 'invalid_body', issues: b.error.issues }, { status: 400 });
    const { range, compare } = await resolveForTenant(tenant.id, { ...b.data, compareTo: b.data.compareTo ?? 'previous' });
    if (!compare) return json({ status: 'unavailable', reason: 'No comparison period.' });
    return json(await generateNarrative({ scope, range, compare, force: b.data.force }));
  });
}
