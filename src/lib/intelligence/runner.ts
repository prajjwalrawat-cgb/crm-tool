import 'server-only';

import { complete } from '@/lib/ai/complete';
import { aiLive, aiModeLabel } from '@/lib/ai/config';
import { hashContent } from '@/lib/ai/embed';
import { AI_MODELS } from '@/lib/ai/openai';
import { listPatternsByType } from '@/lib/agents/patterns/queries';
import { applyLearnedBoost } from '@/lib/agents/scoring/boost';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { db } from '@/db';

import { checkBudget } from './budget';
import { readInsight, writeInsight, type CacheLookup } from './cache';
import {
  DAILY_EXEC_SYSTEM,
  DEAL_SUMMARY_SYSTEM,
  PIPELINE_SUMMARY_SYSTEM,
  PROMPT_VERSION,
  RECOMMENDATIONS_SYSTEM,
  RISK_FLAGS_SYSTEM,
  THREAD_SUMMARY_SYSTEM,
} from './prompts';
import {
  buildDailyExecSource,
  buildDealSummarySource,
  buildPipelineSummarySource,
  buildRecommendationSource,
  buildRiskFlagSource,
  buildThreadSummarySource,
  type RecCandidate,
  type RiskCandidate,
} from './source';
import type {
  DailyExecSummary,
  DealAiSummary,
  InsightState,
  PipelineSummary,
  Recommendation,
  RiskFlag,
  ThreadAiSummary,
} from './types';
import {
  generateMockDailyExec,
  generateMockDealSummary,
  generateMockPipelineSummary,
  generateMockRecommendations,
  generateMockRiskFlags,
  generateMockThreadSummary,
} from './mock-generators';

/**
 * The intelligence runner is the single entry point pages use to fetch
 * an insight. It NEVER awaits OpenAI on the read path:
 *
 *   1. Build the source projection (cheap CRM queries)
 *   2. Look up the cache (one indexed SELECT)
 *   3. If cache state is `cached`, return JSON-parsed content
 *   4. Otherwise, kick a regen call asynchronously (fire-and-forget)
 *      and return the stale row (or null) to the page
 *
 * The page renders the right state via `<AiInsightCard state={...} />`.
 * When the async regen finishes, a `ai.summary.updated` realtime event
 * is published; the client swaps to the fresh content.
 *
 * Why call OpenAI from here at all (instead of dispatching to Inngest)?
 * In mock mode the model call is a pure function — completes in < 5ms.
 * In live mode it's a network call that's still fine to fire-and-forget
 * because the user is already getting a stale-or-empty response.
 * Dispatching to Inngest adds complexity (event registration, durable
 * retries) that's worth it for retry-critical workflows but overkill
 * for "the AI summary card might re-render in 2 seconds".
 */

type ParsedInsight<T> = { state: InsightState; content: T | null; generatedAt: Date | null };

export async function getDailyExecInsight(
  tenantId: string,
  actorUserId: string | null,
  isoDate: string,
): Promise<ParsedInsight<DailyExecSummary>> {
  const { source } = await buildDailyExecSource(tenantId, isoDate);
  const cache = await readInsight(tenantId, 'daily-exec', isoDate, source);

  if (cache.state === 'cached') {
    return parseCached<DailyExecSummary>(cache);
  }

  // Fire-and-forget regen. We don't await it — the page gets stale-or-null
  // and a realtime event will swap content when fresh data is ready.
  void regenDailyExec({ tenantId, actorUserId, isoDate, source }).catch(
    (err) => {
      // Swallow — the audit row already captured the failure via complete().
      console.error('[intelligence] daily-exec regen failed', err);
    },
  );

  return parseCached<DailyExecSummary>(cache);
}

export async function getDealSummaryInsight(
  tenantId: string,
  actorUserId: string | null,
  dealId: string,
): Promise<ParsedInsight<DealAiSummary>> {
  const built = await buildDealSummarySource(tenantId, dealId);
  if (!built) {
    return { state: 'generating', content: null, generatedAt: null };
  }
  const { source } = built;
  const cache = await readInsight(tenantId, 'deal-summary', dealId, source);
  if (cache.state === 'cached') return parseCached<DealAiSummary>(cache);
  void regenDealSummary({ tenantId, actorUserId, dealId, source }).catch(
    (err) => console.error('[intelligence] deal-summary regen failed', err),
  );
  return parseCached<DealAiSummary>(cache);
}

/**
 * Per-thread AI summary. Read-through; regen fires asynchronously
 * when the source has changed. The thread detail page subscribes to
 * `ai.summary.updated` to swap content on completion.
 */
export async function getThreadSummaryInsight(
  tenantId: string,
  actorUserId: string | null,
  threadId: string,
): Promise<ParsedInsight<ThreadAiSummary>> {
  const built = await buildThreadSummarySource(tenantId, threadId);
  if (!built) {
    return { state: 'generating', content: null, generatedAt: null };
  }
  const { source } = built;
  const cache = await readInsight(tenantId, 'thread-summary', threadId, source);
  if (cache.state === 'cached') return parseCached<ThreadAiSummary>(cache);
  void regenThreadSummary({ tenantId, actorUserId, threadId, source }).catch(
    (err) => console.error('[intelligence] thread-summary regen failed', err),
  );
  return parseCached<ThreadAiSummary>(cache);
}

export async function getRiskFlagInsight(
  tenantId: string,
  actorUserId: string | null,
): Promise<ParsedInsight<{ flags: RiskFlag[] }>> {
  const { source, candidates } = await buildRiskFlagSource(tenantId);
  const cache = await readInsight(tenantId, 'risk-flag-set', 'global', source);
  if (cache.state === 'cached')
    return parseCached<{ flags: RiskFlag[] }>(cache);
  void regenRiskFlags({ tenantId, actorUserId, candidates, source }).catch(
    (err) => console.error('[intelligence] risk-flag regen failed', err),
  );
  return parseCached<{ flags: RiskFlag[] }>(cache);
}

export async function getRecommendationInsight(
  tenantId: string,
  actorUserId: string | null,
): Promise<ParsedInsight<{ recommendations: Recommendation[] }>> {
  const { source, candidates } = await buildRecommendationSource(tenantId);
  const cache = await readInsight(
    tenantId,
    'recommendation-set',
    'global',
    source,
  );
  if (cache.state === 'cached')
    return parseCached<{ recommendations: Recommendation[] }>(cache);
  void regenRecommendations({ tenantId, actorUserId, candidates, source }).catch(
    (err) =>
      console.error('[intelligence] recommendation regen failed', err),
  );
  return parseCached<{ recommendations: Recommendation[] }>(cache);
}

export async function getPipelineSummaryInsight(
  tenantId: string,
  actorUserId: string | null,
): Promise<ParsedInsight<PipelineSummary>> {
  const { source } = await buildPipelineSummarySource(tenantId);
  const cache = await readInsight(
    tenantId,
    'pipeline-summary',
    'global',
    source,
  );
  if (cache.state === 'cached')
    return parseCached<PipelineSummary>(cache);
  void regenPipelineSummary({ tenantId, actorUserId, source }).catch((err) =>
    console.error('[intelligence] pipeline-summary regen failed', err),
  );
  return parseCached<PipelineSummary>(cache);
}

/* ---------- Regen workers (fire-and-forget) ---------- */

async function regenDailyExec(args: {
  tenantId: string;
  actorUserId: string | null;
  isoDate: string;
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const summary = aiLive()
    ? await runJsonCompletion<DailyExecSummary>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: DAILY_EXEC_SYSTEM,
        userContent: args.source,
        insightType: 'daily-exec',
      })
    : generateMockDailyExec(JSON.parse(args.source), await getOrgSettings(args.tenantId));
  if (!summary) return;
  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'daily-exec',
    entityId: args.isoDate,
    content: JSON.stringify(summary),
    sourceHash: hashContent(args.source),
  });
}

async function regenDealSummary(args: {
  tenantId: string;
  actorUserId: string | null;
  dealId: string;
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const summary = aiLive()
    ? await runJsonCompletion<DealAiSummary>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: DEAL_SUMMARY_SYSTEM,
        userContent: args.source,
        insightType: 'deal-summary',
      })
    : generateMockDealSummary(JSON.parse(args.source), await getOrgSettings(args.tenantId));
  if (!summary) return;
  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'deal-summary',
    entityId: args.dealId,
    content: JSON.stringify(summary),
    sourceHash: hashContent(args.source),
  });
}

async function regenThreadSummary(args: {
  tenantId: string;
  actorUserId: string | null;
  threadId: string;
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const summary = aiLive()
    ? await runJsonCompletion<ThreadAiSummary>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: THREAD_SUMMARY_SYSTEM,
        userContent: args.source,
        insightType: 'thread-summary',
      })
    : generateMockThreadSummary(JSON.parse(args.source));
  if (!summary) return;
  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'thread-summary',
    entityId: args.threadId,
    content: JSON.stringify(summary),
    sourceHash: hashContent(args.source),
  });
}

async function regenRiskFlags(args: {
  tenantId: string;
  actorUserId: string | null;
  candidates: RiskCandidate[];
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const result = aiLive()
    ? await runJsonCompletion<{ flags: RiskFlag[] }>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: RISK_FLAGS_SYSTEM,
        userContent: args.source,
        insightType: 'risk-flag-set',
      })
    : { flags: generateMockRiskFlags(args.candidates) };
  if (!result) return;
  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'risk-flag-set',
    entityId: 'global',
    content: JSON.stringify(result),
    sourceHash: hashContent(args.source),
  });

  // Side-channel update so the bell can refresh badge counts without
  // re-fetching the full insight.
  const counts = { info: 0, warning: 0, danger: 0 };
  for (const f of result.flags) counts[f.severity]++;
  await publishRealtimeEvent(db, {
    type: 'intelligence.risk.updated',
    tenantId: args.tenantId,
    counts,
  });
}

async function regenRecommendations(args: {
  tenantId: string;
  actorUserId: string | null;
  candidates: RecCandidate[];
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const result = aiLive()
    ? await runJsonCompletion<{ recommendations: Recommendation[] }>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: RECOMMENDATIONS_SYSTEM,
        userContent: args.source,
        insightType: 'recommendation-set',
      })
    : { recommendations: generateMockRecommendations(args.candidates) };
  if (!result) return;

  // Recommendation V2: enrich each recommendation with the learned
  // patterns that match its underlying candidate. The model already
  // ranked by leverage; we don't reorder here (keeps prompt + boost
  // concerns separated), but we surface `patternSource` so the UI
  // can explain "why am I seeing this" and the future ranker can
  // weight by accumulated feedback.
  const enriched = await enrichRecommendationsWithPatterns({
    tenantId: args.tenantId,
    candidates: args.candidates,
    recommendations: result.recommendations,
  });
  const finalResult = { recommendations: enriched };

  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'recommendation-set',
    entityId: 'global',
    content: JSON.stringify(finalResult),
    sourceHash: hashContent(args.source),
  });
  await publishRealtimeEvent(db, {
    type: 'intelligence.recommendation.updated',
    tenantId: args.tenantId,
    count: finalResult.recommendations.length,
  });
}

/**
 * Attach learned-pattern provenance to recommendations whose
 * candidate matches a known pattern. The boost itself is bounded at
 * +/-35% by `applyLearnedBoost`; v1 doesn't re-rank, just decorates.
 */
async function enrichRecommendationsWithPatterns(input: {
  tenantId: string;
  candidates: RecCandidate[];
  recommendations: Recommendation[];
}): Promise<Recommendation[]> {
  const patterns = await listPatternsByType(input.tenantId, 'followup_timing');
  if (patterns.length === 0) return input.recommendations;

  const candById = new Map(input.candidates.map((c) => [c.dealId, c]));

  return input.recommendations.map((rec) => {
    if (rec.entity.type !== 'deal') return rec;
    const cand = candById.get(rec.entity.id);
    if (!cand) return rec;

    const hoursToFirstFollowup =
      cand.lastActivityAt && cand.createdAt
        ? Math.max(
            0,
            (new Date(cand.lastActivityAt).getTime() -
              new Date(cand.createdAt).getTime()) /
              (1000 * 60 * 60),
          )
        : null;

    const boost = applyLearnedBoost({
      heuristicScore: rec.confidence,
      patterns,
      context: { hoursToFirstFollowup },
    });
    if (boost.matches.length === 0) return rec;

    return {
      ...rec,
      patternSource: boost.matches.map((m) => ({
        patternType: m.patternType,
        confidence: m.confidence,
        sampleSize: m.sampleSize,
        headline: m.headline,
        detail: m.detail,
      })),
    };
  });
}

async function regenPipelineSummary(args: {
  tenantId: string;
  actorUserId: string | null;
  source: string;
}): Promise<void> {
  if (await aboveBudget(args.tenantId)) return;
  const result = aiLive()
    ? await runJsonCompletion<PipelineSummary>({
        tenantId: args.tenantId,
        actorUserId: args.actorUserId,
        system: PIPELINE_SUMMARY_SYSTEM,
        userContent: args.source,
        insightType: 'pipeline-summary',
      })
    : generateMockPipelineSummary(JSON.parse(args.source), await getOrgSettings(args.tenantId));
  if (!result) return;
  await persistAndAnnounce({
    tenantId: args.tenantId,
    insightType: 'pipeline-summary',
    entityId: 'global',
    content: JSON.stringify(result),
    sourceHash: hashContent(args.source),
  });
}

/* ---------- helpers ---------- */

async function aboveBudget(tenantId: string): Promise<boolean> {
  if (!aiLive()) return false;
  const b = await checkBudget(tenantId, 1_000);
  return !b.ok;
}

async function runJsonCompletion<T>(args: {
  tenantId: string;
  actorUserId: string | null;
  system: string;
  userContent: string;
  insightType: string;
}): Promise<T | null> {
  try {
    const result = await complete({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      kind: 'summary',
      model: AI_MODELS.summary,
      temperature: 0.2,
      maxTokens: 600,
      metadata: {
        insightType: args.insightType,
        promptVersion: PROMPT_VERSION,
      },
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.userContent },
      ],
    });
    const trimmed = result.content.trim();
    // Defensive: some models still wrap JSON in fences despite system prompt.
    const cleaned = trimmed
      .replace(/^```(?:json)?\n?/i, '')
      .replace(/\n?```$/, '');
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.error(`[intelligence] ${args.insightType} parse/call failed`, err);
    return null;
  }
}

async function persistAndAnnounce(args: {
  tenantId: string;
  insightType:
    | 'daily-exec'
    | 'deal-summary'
    | 'risk-flag-set'
    | 'recommendation-set'
    | 'pipeline-summary'
    | 'thread-summary';
  entityId: string;
  content: string;
  sourceHash: string;
}): Promise<void> {
  const row = await writeInsight({
    tenantId: args.tenantId,
    insightType: args.insightType,
    entityId: args.entityId,
    content: args.content,
    model: aiLive() ? AI_MODELS.summary : `mock:${aiModeLabel()}`,
    sourceHash: args.sourceHash,
  });
  await publishRealtimeEvent(db, {
    type: 'ai.summary.updated',
    tenantId: args.tenantId,
    entityType: args.insightType,
    entityId: args.entityId,
    generatedAt: row.generatedAt.toISOString(),
  });
}

function parseCached<T>(cache: CacheLookup): ParsedInsight<T> {
  if (cache.content === null) {
    return { state: cache.state, content: null, generatedAt: cache.generatedAt };
  }
  try {
    return {
      state: cache.state,
      content: JSON.parse(cache.content) as T,
      generatedAt: cache.generatedAt,
    };
  } catch {
    // Corrupt row — treat as generating; the next regen will overwrite.
    return { state: 'failed', content: null, generatedAt: cache.generatedAt };
  }
}
