import { Sparkles } from 'lucide-react';

import { withTenantSession } from '@/lib/auth-guard';
import { getAIMode } from '@/lib/ai/config';
import {
  getDailyExecInsight,
  getPipelineSummaryInsight,
  getRecommendationInsight,
  getRiskFlagInsight,
} from '@/lib/intelligence/runner';
import { requirePersonas } from '@/lib/personas/guards';

import {
  LiveDailyExecCard,
  LivePipelineSummaryCard,
  LiveRecommendationsCard,
  LiveRiskFlagsCard,
} from './_components/live-ai-card';

export const metadata = {
  title: 'Intelligence',
};

/**
 * The intelligence dashboard. Server-renders five insight cards in
 * parallel; each is read-through (cache hit or stale, never blocking
 * on OpenAI). Cards swap to fresh state via realtime when the async
 * regen finishes.
 *
 * The page intentionally doesn't subscribe to realtime here — the
 * dashboard shell's SSE listener already handles `ai.summary.updated`
 * events. A future client-side hook will swap card content in place
 * (CP#16B); for now the user sees fresh content on next navigation.
 */
export default async function IntelligenceDashboardPage() {
  await requirePersonas(['manager', 'admin']);
  const aiMode = getAIMode();
  const today = new Date().toISOString().slice(0, 10);

  return await withTenantSession(async ({ tenant, userId }) => {
    const [daily, risk, recs, pipeline] = await Promise.all([
      getDailyExecInsight(tenant.id, userId, today),
      getRiskFlagInsight(tenant.id, userId),
      getRecommendationInsight(tenant.id, userId),
      getPipelineSummaryInsight(tenant.id, userId),
    ]);

    const modeOverride =
      aiMode === 'disabled' ? 'disabled' : aiMode === 'mock' ? 'mock' : undefined;

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
              <Sparkles className="h-3 w-3" aria-hidden />
              Intelligence
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Operational signals, narrated by AI
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Daily summaries, risk detection, and recommendations across your
              pipeline. Insights regenerate as your data changes — no manual
              refresh needed.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-right dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
              AI mode
            </div>
            <div className="font-mono text-sm font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {aiMode}
            </div>
            <div className="mt-0.5 text-[10px] text-slate-500 dark:text-[#A1A1AA]">
              {tenant.name}
            </div>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <LiveDailyExecCard
              tenantId={tenant.id}
              id={today}
              title="Daily executive summary"
              subtitle={`Snapshot for ${today}`}
              tone="info"
              summaryId={null}
              initial={daily.content}
              initialState={daily.state}
              initialGeneratedAt={daily.generatedAt?.toISOString() ?? null}
              modeOverride={modeOverride}
            />
          </div>

          <div className="lg:col-span-4">
            <LivePipelineSummaryCard
              tenantId={tenant.id}
              title="Pipeline narrative"
              subtitle="Stage health + bottlenecks"
              tone="neutral"
              summaryId={null}
              initial={pipeline.content}
              initialState={pipeline.state}
              initialGeneratedAt={pipeline.generatedAt?.toISOString() ?? null}
              modeOverride={modeOverride}
            />
          </div>

          <div className="lg:col-span-6">
            <LiveRiskFlagsCard
              tenantId={tenant.id}
              title="Risk detection"
              subtitle="Deals showing signs of stalling"
              tone="warning"
              summaryId={null}
              initial={risk.content?.flags ?? []}
              initialState={risk.state}
              initialGeneratedAt={risk.generatedAt?.toISOString() ?? null}
              modeOverride={modeOverride}
            />
          </div>

          <div className="lg:col-span-6">
            <LiveRecommendationsCard
              tenantId={tenant.id}
              title="Recommendations"
              subtitle="Highest-leverage next actions"
              tone="success"
              summaryId={null}
              initial={recs.content?.recommendations ?? []}
              initialState={recs.state}
              initialGeneratedAt={recs.generatedAt?.toISOString() ?? null}
              modeOverride={modeOverride}
            />
          </div>
        </div>

        <p className="mt-5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
          AI insights are generated against your own data only. Outputs are
          cached and regenerate when underlying data changes. Confidence scores
          reflect available signal density — treat them as a guide, not a
          guarantee.
        </p>
      </main>
    );
  });
}
