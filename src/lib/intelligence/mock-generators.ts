import 'server-only';

import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';

import type {
  DailyExecSummary,
  DealAiSummary,
  PipelineSummary,
  Recommendation,
  RiskFlag,
  ThreadAiSummary,
} from './types';
import type {
  DailyExecSourcePayload,
  PipelineSummarySourcePayload,
  RecCandidate,
  RiskCandidate,
} from './source';

/**
 * Deterministic mock generators. Same input → same output. The purpose
 * isn't to imitate model quality; it's to keep every cache + realtime
 * path exercised when AI is disabled, and to keep development cheap.
 *
 * Each function takes the same source payload the live prompt would
 * consume, so the output is at least shape-consistent with what the
 * model would emit.
 */

const MOCK_NOTICE = '(mock)';

export function generateMockDailyExec(
  payload: DailyExecSourcePayload,
  ctx: TenantCurrencyContext,
): DailyExecSummary {
  const won = payload.closed.find((c) => c.stage === 'won');
  const lost = payload.closed.find((c) => c.stage === 'lost');
  const money = (minor: number) => formatTenantCurrency(minor, ctx);
  const lostCount = lost?.count ?? 0;

  const bullets: string[] = [
    `Active pipeline: ${payload.activeCount} deals, ${money(payload.pipelineTotal)} total.`,
  ];
  if (won) {
    bullets.push(
      `${won.count} deals won this week — ${money(won.total)} closed revenue.`,
    );
  }
  if (lost) {
    bullets.push(`${lostCount} losses in window. Review them in the win/loss report.`);
  }
  if (payload.stageChangeCount > 0) {
    bullets.push(
      `${payload.stageChangeCount} stage transitions logged in the past 7 days.`,
    );
  }
  bullets.push(
    `${payload.recent.length} recent activity events covered in this snapshot. ${MOCK_NOTICE}`,
  );

  const headline =
    won && won.count > 0
      ? `Pipeline closed ${money(won.total)} this week.`
      : `Pipeline holding at ${payload.activeCount} active deals.`;

  return {
    headline,
    bullets,
    callout:
      lost && lost.count >= 3
        ? {
            title: 'Loss spike',
            detail: `${lost.count} deals lost in 7 days — check win/loss report.`,
            severity: 'warning',
          }
        : undefined,
  };
}

export function generateMockDealSummary(
  payload: { deal: { stage: string; amount_minor: number; probability: number | null }; activities: unknown[]; emails: unknown[]; tasks: unknown[] },
  ctx: TenantCurrencyContext,
): DealAiSummary {
  const stage = payload.deal.stage;
  const activityCount = payload.activities.length;
  const emailCount = payload.emails.length;
  const taskCount = payload.tasks.length;

  return {
    narrative: `Deal is in ${stage} at ${formatTenantCurrency(payload.deal.amount_minor, ctx)}. ${activityCount} recent activity events, ${emailCount} emails logged. ${MOCK_NOTICE}`,
    risks: activityCount === 0 ? ['No activity logged on this deal yet'] : [],
    nextActions: [
      emailCount === 0 ? 'Send an initial outreach email' : 'Send a follow-up email',
      taskCount === 0 ? 'Create a follow-up task' : 'Review open tasks',
    ],
    confidence: Math.min(0.9, 0.3 + activityCount * 0.05 + emailCount * 0.05),
  };
}

export function generateMockRiskFlags(candidates: RiskCandidate[]): RiskFlag[] {
  return candidates.slice(0, 6).map((c) => {
    const signals: RiskFlag['signals'] = [];
    if (c.staleActivity) signals.push('no_recent_activity');
    if (c.staleEmail) signals.push('no_recent_email');
    if (signals.length === 0) signals.push('stalled_at_stage');

    const isBigStale =
      c.amountMinor > 5_000_000 && c.staleActivity && c.staleEmail;
    const severity: RiskFlag['severity'] = isBigStale
      ? 'danger'
      : c.amountMinor > 2_000_000
        ? 'warning'
        : 'info';

    const reasonParts: string[] = [];
    if (c.staleActivity) reasonParts.push('no activity in 14+ days');
    if (c.staleEmail) reasonParts.push('no outbound email in 9+ days');
    const reason = `${reasonParts.join(' and ')}. Currently in ${c.stage}.`;

    return {
      entity: { type: 'deal' as const, id: c.dealId, name: c.name },
      severity,
      title: `${c.name} — ${signals[0]?.replace(/_/g, ' ')}`,
      reason,
      signals,
      confidence: isBigStale ? 0.85 : 0.6,
    };
  });
}

export function generateMockRecommendations(
  candidates: RecCandidate[],
): Recommendation[] {
  return candidates.slice(0, 5).map((c) => {
    if (c.overdueTasks > 0) {
      return {
        entity: { type: 'deal' as const, id: c.dealId, name: c.name },
        title: `Clear overdue tasks on ${c.name}`,
        rationale: `${c.overdueTasks} overdue task(s) blocking progress on a ${c.stage} deal.`,
        actionKind: 'create_task' as const,
        suggestion: {
          text: `Triage overdue tasks for ${c.name}`,
          dueInDays: 1,
        },
        confidence: 0.75,
      };
    }
    if (!c.lastActivityAt) {
      return {
        entity: { type: 'deal' as const, id: c.dealId, name: c.name },
        title: `Kick off outreach for ${c.name}`,
        rationale: `No activity logged yet — start with an introduction email.`,
        actionKind: 'send_email' as const,
        suggestion: {
          text: `Initial outreach: ${c.name}`,
        },
        confidence: 0.65,
      };
    }
    return {
      entity: { type: 'deal' as const, id: c.dealId, name: c.name },
      title: `Follow up on ${c.name}`,
      rationale: `Last activity was ${c.lastActivityAt}. Re-engage to keep momentum.`,
      actionKind: 'send_email' as const,
      suggestion: { text: `Quick check-in: ${c.name}` },
      confidence: 0.55,
    };
  });
}

export function generateMockPipelineSummary(
  payload: PipelineSummarySourcePayload,
  ctx: TenantCurrencyContext,
): PipelineSummary {
  const money = (minor: number) => formatTenantCurrency(minor, ctx);
  const active = payload.perStage.filter(
    (s) => s.stage !== 'won' && s.stage !== 'lost',
  );
  const totalActive = active.reduce((s, r) => s + r.count, 0);
  const totalValueMinor = active.reduce(
    (s, r) => s + r.totalAmountMinor,
    0,
  );

  // Bottleneck: stage with avg-value-per-deal much higher than its neighbours
  // OR with 3x the count of the next stage. Simple heuristic for mock.
  const bottlenecks: PipelineSummary['bottlenecks'] = [];
  for (let i = 0; i < active.length - 1; i++) {
    const cur = active[i]!;
    const next = active[i + 1]!;
    if (cur.count >= 5 && next.count > 0 && cur.count >= next.count * 3) {
      bottlenecks.push({
        stage: cur.stage,
        reason: `${cur.count} deals stuck in ${cur.stage} vs ${next.count} in ${next.stage}.`,
      });
    }
  }

  return {
    headline: `${totalActive} active deals worth ${money(totalValueMinor)}.`,
    bullets: active.map(
      (s) => `${s.stage}: ${s.count} deals, ${money(s.totalAmountMinor)}.`,
    ),
    bottlenecks,
  };
}

/**
 * Mock thread summary. Deterministic — derives narrative + lists from
 * structural payload features (message count, failed deliveries, time
 * since last activity). Same input → same output.
 */
export function generateMockThreadSummary(payload: {
  thread: {
    messageCount: number;
    failedCount: number;
    subject: string;
    lastMessageAt: string;
  };
  messages: Array<{ sender: string; preview: string; at: string; status: string }>;
  events: Array<{ kind: string; at: string }>;
}): ThreadAiSummary {
  const { thread, messages, events } = payload;
  const lastMessage = messages[messages.length - 1];
  const lastSender = lastMessage?.sender ?? 'someone';
  const replyEvents = events.filter((e) => e.kind === 'replied').length;
  const failed = thread.failedCount;
  const hasFails = failed > 0;

  const narrative =
    messages.length === 0
      ? `No messages on this thread yet. ${MOCK_NOTICE}`
      : `Thread "${thread.subject || 'no subject'}" has ${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}. Latest from ${lastSender}. ${MOCK_NOTICE}`;

  const unresolved: string[] = [];
  if (messages.length > 1 && replyEvents === 0) {
    unresolved.push('No recorded replies yet — last outbound may need a follow-up.');
  }

  const nextActions: string[] = [];
  if (messages.length === 0) {
    nextActions.push('Start an outbound message to kick off the conversation.');
  } else if (replyEvents === 0 && thread.messageCount >= 2) {
    nextActions.push('Send a follow-up to nudge a reply.');
  } else {
    nextActions.push('Continue the conversation when there\'s a clear next step.');
  }
  if (hasFails) {
    nextActions.push(`Retry the ${failed} failed delivery${failed === 1 ? '' : 's'}.`);
  }

  const riskNotes: string[] = [];
  if (hasFails) {
    riskNotes.push(
      `${failed} message${failed === 1 ? '' : 's'} failed to deliver — check the sender setup.`,
    );
  }
  // Sentiment: positive if recent reply, negative if failed, neutral otherwise.
  const sentiment: ThreadAiSummary['sentiment'] = hasFails
    ? 'negative'
    : replyEvents > 0
      ? 'positive'
      : 'neutral';

  // Confidence rises with message volume; clamped at 0.85.
  const confidence = Math.min(0.85, 0.3 + messages.length * 0.05);

  return {
    narrative,
    unresolved,
    nextActions,
    riskNotes,
    sentiment,
    confidence,
  };
}
