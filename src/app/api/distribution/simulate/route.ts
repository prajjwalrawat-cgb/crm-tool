import { NextResponse, type NextRequest } from 'next/server';

import { withApiPermission } from '@/lib/lead-capture/api-auth';
import { simulateDistribution } from '@/lib/lead-capture/distribute';
import { simulateInputSchema } from '@/lib/lead-capture/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/distribution/simulate?sourceId=&city=&state=&productInterest=…
 * (or ?lead=<url-encoded JSON>). Dry run: which rule matches and who would get
 * the lead right now. No writes, no rotation lock.
 */
export async function GET(request: NextRequest) {
  return withApiPermission('manageLeadCapture', async ({ tenantId }) => {
    const q = request.nextUrl.searchParams;
    let sample: unknown;
    try {
      sample = q.get('lead') ? JSON.parse(q.get('lead')!) : Object.fromEntries(q.entries());
    } catch {
      return NextResponse.json({ error: 'invalid_lead_json' }, { status: 400 });
    }
    const parsed = simulateInputSchema.safeParse(sample);
    if (!parsed.success) return NextResponse.json({ error: 'invalid', issues: parsed.error.issues }, { status: 400 });
    const plan = await simulateDistribution({ tenantId, sample: parsed.data });
    return NextResponse.json({
      kind: plan.kind,
      rule: plan.rule ? { id: plan.rule.id, name: plan.rule.name, strategy: plan.rule.strategy } : null,
      userId: plan.kind === 'assign' ? plan.userId : null,
      reason: plan.reason,
      retryAt: plan.kind !== 'assign' && plan.retryAt ? plan.retryAt.toISOString() : null,
      eligibility: plan.eligibility,
    });
  });
}
