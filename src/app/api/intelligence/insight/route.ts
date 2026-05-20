import { NextResponse, type NextRequest } from 'next/server';

import { withTenantSession } from '@/lib/auth-guard';
import {
  getDailyExecInsight,
  getDealSummaryInsight,
  getPipelineSummaryInsight,
  getRecommendationInsight,
  getRiskFlagInsight,
} from '@/lib/intelligence/runner';
import {
  INSIGHT_TYPES,
  type InsightType,
} from '@/lib/intelligence/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tiny read endpoint for one insight by (type, id). The live-refresh
 * hook calls this on `ai.summary.updated` to swap card content without
 * a full page reload.
 *
 * Auth: standard tenant session. The runner already enforces tenant
 * isolation via RLS — the route just exposes it over HTTP.
 *
 * Query:
 *   ?type=daily-exec&id=2026-05-20
 *   ?type=deal-summary&id=<dealId>
 *   ?type=risk-flag-set&id=global   (id can be omitted; defaults global)
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const typeParam = url.searchParams.get('type');
  const idParam = url.searchParams.get('id');

  if (!typeParam || !INSIGHT_TYPES.includes(typeParam as InsightType)) {
    return NextResponse.json(
      { ok: false, message: 'Unknown insight type' },
      { status: 400 },
    );
  }
  const type = typeParam as InsightType;
  const id = idParam ?? 'global';

  return await withTenantSession(async ({ tenant, userId }) => {
    let payload;
    switch (type) {
      case 'daily-exec':
        payload = await getDailyExecInsight(tenant.id, userId, id);
        break;
      case 'deal-summary':
        payload = await getDealSummaryInsight(tenant.id, userId, id);
        break;
      case 'risk-flag-set':
        payload = await getRiskFlagInsight(tenant.id, userId);
        break;
      case 'recommendation-set':
        payload = await getRecommendationInsight(tenant.id, userId);
        break;
      case 'pipeline-summary':
        payload = await getPipelineSummaryInsight(tenant.id, userId);
        break;
      case 'activity-summary':
        // Not implemented yet — placeholder for CP#16C.
        payload = { state: 'generating', content: null, generatedAt: null };
        break;
    }
    return NextResponse.json({
      ok: true,
      state: payload.state,
      content: payload.content,
      generatedAt: payload.generatedAt?.toISOString() ?? null,
    });
  });
}
