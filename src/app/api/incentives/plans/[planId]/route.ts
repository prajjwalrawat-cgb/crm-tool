import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import {
  buildLadder,
  calculateIncentive,
  creditedRevenueForFullTarget,
  marginStatus,
  whatItTakes,
} from '@/lib/incentives/engine';
import { loadPlanForViewer } from '@/lib/incentives/queries';
import { actualsInput } from '@/lib/incentives/types';
import { requireMembership } from '@/lib/membership';
import { getOrgSettings } from '@/lib/org-settings/queries';

/**
 * GET /api/incentives/plans/:planId
 *
 * One plan, its current actuals, and the engine's full output for them —
 * the same `calculateIncentive` the pages render, so the API and the UI
 * cannot disagree.
 *
 * Scope: `loadPlanForViewer` — your own plan, or the team's with
 * `viewTeamIncentives`. Everything else (another SPOC's plan, another
 * tenant's, an id that doesn't exist) is the same 404, so ids can't be
 * probed.
 *
 * `?prior=&netNew=&margin=` overrides the stored actuals for a what-if
 * (margin as a fraction). Nothing is written.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { planId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) {
    return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
  }
  const url = new URL(req.url);

  const bundle = await runWithTenantContext({ tenantId: orgId, userId }, async () => {
    const membership = await requireMembership();
    const settings = await getOrgSettings(orgId);
    return await loadPlanForViewer(
      orgId,
      { userId, role: membership.role },
      planId,
      settings.fiscalYearStartMonth ?? 1,
    );
  });
  if (!bundle) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });

  const stored = bundle.actuals ? actualsInput(bundle.actuals) : null;
  const whatIf = ['prior', 'netNew', 'margin'].some((k) => url.searchParams.has(k));
  const actuals = whatIf
    ? {
        priorYearRevenueCr: url.searchParams.get('prior') ?? stored?.priorYearRevenueCr ?? '0',
        netNewRevenueCr: url.searchParams.get('netNew') ?? stored?.netNewRevenueCr ?? '0',
        blendedMarginPct: url.searchParams.get('margin') ?? stored?.blendedMarginPct ?? '0',
      }
    : stored;

  try {
    const terms = bundle.plan.terms;
    return NextResponse.json({
      plan: bundle.plan,
      actuals: bundle.actuals,
      whatIf,
      creditedRevenueForFullTarget: creditedRevenueForFullTarget(terms),
      result: actuals ? calculateIncentive(terms, actuals) : null,
      whatItTakes: actuals ? whatItTakes(terms, actuals) : null,
      marginStatus: actuals ? marginStatus(terms, actuals) : null,
      ladder: buildLadder(terms, {
        currentCreditedCr: actuals ? calculateIncentive(terms, actuals).creditedRevenue : null,
      }),
    });
  } catch (err) {
    // Invalid what-if input (negative, non-numeric) is the caller's error.
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid input' }, { status: 400 });
  }
}
