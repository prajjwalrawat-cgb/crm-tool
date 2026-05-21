'use client';

import type { ReactNode } from 'react';

import { useLiveInsight } from '@/hooks/use-live-insight';
import type {
  DailyExecSummary,
  DealAiSummary,
  InsightState,
  PipelineSummary,
  Recommendation,
  RiskFlag,
  ThreadAiSummary,
} from '@/lib/intelligence/types';

import { AiInsightCard, type AiInsightCardProps } from './ai-insight-card';
import {
  DailyExecBody,
  DealSummaryBody,
  PipelineSummaryBody,
  RecommendationsBody,
  RiskFlagsBody,
  ThreadSummaryBody,
} from './insight-bodies';

/**
 * Thin client wrapper around <AiInsightCard /> that swaps content live
 * when a matching `ai.summary.updated` realtime event arrives.
 *
 * One component per insight type so the typed payload stays clean; the
 * card chrome and feedback footer are reused via composition.
 */

type CommonProps = Omit<
  AiInsightCardProps,
  'state' | 'generatedAt' | 'children'
> & {
  tenantId: string;
  initialState: InsightState;
  initialGeneratedAt: string | null;
  modeOverride?: 'mock' | 'disabled';
};

export function LiveDailyExecCard(
  props: CommonProps & { id: string; initial: DailyExecSummary | null },
) {
  const live = useLiveInsight<DailyExecSummary>({
    tenantId: props.tenantId,
    type: 'daily-exec',
    id: props.id,
    initial: {
      state: props.initialState,
      content: props.initial,
      generatedAt: props.initialGeneratedAt,
    },
  });
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <DailyExecBody data={live.content} />
    </AiInsightCard>
  );
}

export function LivePipelineSummaryCard(
  props: CommonProps & { initial: PipelineSummary | null },
) {
  const live = useLiveInsight<PipelineSummary>({
    tenantId: props.tenantId,
    type: 'pipeline-summary',
    id: 'global',
    initial: {
      state: props.initialState,
      content: props.initial,
      generatedAt: props.initialGeneratedAt,
    },
  });
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <PipelineSummaryBody data={live.content} />
    </AiInsightCard>
  );
}

export function LiveRiskFlagsCard(
  props: CommonProps & { initial: RiskFlag[] },
) {
  const live = useLiveInsight<{ flags: RiskFlag[] }>({
    tenantId: props.tenantId,
    type: 'risk-flag-set',
    id: 'global',
    initial: {
      state: props.initialState,
      content: { flags: props.initial },
      generatedAt: props.initialGeneratedAt,
    },
  });
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <RiskFlagsBody flags={live.content?.flags ?? []} />
    </AiInsightCard>
  );
}

export function LiveRecommendationsCard(
  props: CommonProps & {
    initial: Recommendation[];
    limit?: number;
  },
) {
  const live = useLiveInsight<{ recommendations: Recommendation[] }>({
    tenantId: props.tenantId,
    type: 'recommendation-set',
    id: 'global',
    initial: {
      state: props.initialState,
      content: { recommendations: props.initial },
      generatedAt: props.initialGeneratedAt,
    },
  });
  const recs = (live.content?.recommendations ?? []).slice(
    0,
    props.limit ?? Infinity,
  );
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <RecommendationsBody recommendations={recs} />
    </AiInsightCard>
  );
}

export function LiveDealSummaryCard(
  props: CommonProps & { dealId: string; initial: DealAiSummary | null },
) {
  const live = useLiveInsight<DealAiSummary>({
    tenantId: props.tenantId,
    type: 'deal-summary',
    id: props.dealId,
    initial: {
      state: props.initialState,
      content: props.initial,
      generatedAt: props.initialGeneratedAt,
    },
  });
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <DealSummaryBody data={live.content} />
    </AiInsightCard>
  );
}

export function LiveThreadSummaryCard(
  props: CommonProps & { threadId: string; initial: ThreadAiSummary | null },
) {
  const live = useLiveInsight<ThreadAiSummary>({
    tenantId: props.tenantId,
    type: 'thread-summary',
    id: props.threadId,
    initial: {
      state: props.initialState,
      content: props.initial,
      generatedAt: props.initialGeneratedAt,
    },
  });
  return (
    <AiInsightCard
      {...stripWrapperProps(props)}
      state={resolveState(live.state, props.modeOverride)}
      generatedAt={live.generatedAt}
    >
      <ThreadSummaryBody data={live.content} />
    </AiInsightCard>
  );
}

function stripWrapperProps(p: CommonProps): Omit<
  AiInsightCardProps,
  'state' | 'generatedAt' | 'children'
> {
  // Pluck out the wrapper-only props so they don't leak into the card.
  const {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    tenantId: _tenantId,
    initialState: _initialState,
    initialGeneratedAt: _initialGeneratedAt,
    modeOverride: _modeOverride,
    /* eslint-enable @typescript-eslint/no-unused-vars */
    ...rest
  } = p;
  return rest;
}

function resolveState(
  raw: InsightState,
  override?: 'mock' | 'disabled',
): InsightState {
  if (override === 'disabled') return 'disabled';
  if (override === 'mock' && raw === 'cached') return 'mock';
  return raw;
}

/** A render-time helper: build the initial children node for cards we wrap. */
export type LiveCardInitial<T> = {
  state: InsightState;
  content: T | null;
  generatedAt: string | null;
};

export function deriveInitial<T>(serverPayload: {
  state: InsightState;
  content: T | null;
  generatedAt: Date | null;
}): LiveCardInitial<T> {
  return {
    state: serverPayload.state,
    content: serverPayload.content,
    generatedAt: serverPayload.generatedAt?.toISOString() ?? null,
  };
}

/** Generic empty/typed-default fallbacks used by the page when content is null. */
export function emptyChildren(): ReactNode {
  return null;
}
