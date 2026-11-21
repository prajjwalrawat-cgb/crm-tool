import type { AIMode } from '@/lib/ai/config';
import type { MetricsSnapshot } from '@/lib/observability';
import type { AIInvocationStats, WorkflowStats } from '@/lib/ops/queries';

import { fmtNumber, Section, StatTile } from './primitives';

export function OverviewSection({
  aiMode,
  showAi,
  aiStats,
  runStats,
  metrics,
}: {
  aiMode: AIMode;
  /** False while AI is switched off — hides the AI tiles (no MOCK on screen). */
  showAi: boolean;
  aiStats: AIInvocationStats;
  runStats: WorkflowStats;
  metrics: MetricsSnapshot;
}) {
  const aiTone = aiMode === 'live' ? 'success' : aiMode === 'disabled' ? 'danger' : 'warn';
  const failRate =
    runStats.totalRuns === 0
      ? 0
      : Math.round((runStats.failed / runStats.totalRuns) * 100);
  const sseConnections =
    metrics.gauges['sse.connections'] ?? 0;
  const inFlightChat =
    metrics.gauges['ai.chat.in_flight'] ?? 0;

  return (
    <Section
      title="Overview"
      description="Last 24h tenant-scoped from Postgres + live in-process gauges."
    >
      <div
        className={
          showAi
            ? 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6'
            : 'grid grid-cols-2 gap-3'
        }
      >
        {showAi ? (
          <>
            <StatTile
              label="AI mode"
              value={aiMode.toUpperCase()}
              tone={aiTone}
              hint={aiMode === 'mock' ? 'AI_ENABLED=false' : aiMode === 'disabled' ? 'no API key' : 'live OpenAI'}
            />
            <StatTile
              label="AI calls (24h)"
              value={fmtNumber(aiStats.totalCalls)}
              hint={`${aiStats.errorCount} errors · ${aiStats.skippedCount} skipped`}
              tone={aiStats.errorCount > 0 ? 'warn' : 'default'}
            />
            <StatTile
              label="Tokens (24h)"
              value={fmtNumber(aiStats.totalTokens)}
              hint={aiMode === 'live' ? 'billed' : 'intended'}
              tone="muted"
            />
          </>
        ) : null}
        <StatTile
          label="Workflow runs (24h)"
          value={fmtNumber(runStats.totalRuns)}
          hint={`${runStats.completed} ok · ${runStats.failed} failed · ${runStats.skipped} skipped`}
          tone={failRate > 10 ? 'danger' : failRate > 0 ? 'warn' : 'success'}
        />
        <StatTile
          label="SSE connections"
          value={fmtNumber(sseConnections)}
          hint="open right now"
        />
        {showAi ? (
          <StatTile
            label="Chat in flight"
            value={fmtNumber(inFlightChat)}
            hint="streams currently open"
          />
        ) : null}
      </div>
    </Section>
  );
}
