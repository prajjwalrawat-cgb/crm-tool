import { AlertTriangle } from 'lucide-react';

import type { MetricsSnapshot } from '@/lib/observability';
import type { WorkflowRunRow, WorkflowStats } from '@/lib/ops/queries';

import { fmtDuration, fmtNumber, Section, StatTile, StatusPill } from './primitives';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

export function WorkflowsSection({
  stats,
  recent,
  metrics,
}: {
  stats: WorkflowStats;
  recent: WorkflowRunRow[];
  metrics: MetricsSnapshot;
}) {
  const longestStuck = recent.find((r) => r.status === 'running');
  const stuckMs = longestStuck
    ? Date.now() - longestStuck.startedAt.getTime()
    : null;

  // Surface in-process span counts so devs see "this Node instance has
  // run X embeddings since boot".
  const spansEmbed =
    metrics.histograms['span.duration_ms{span=ai.chat.retrieve}'];

  const inngestUnreachable = (metrics.gauges['inngest.unreachable'] ?? 0) > 0;
  const sendFailures = Object.entries(metrics.counters)
    .filter(([k]) => k.startsWith('inngest.send.failure'))
    .reduce((s, [, v]) => s + v, 0);
  const localDispatched = Object.entries(metrics.counters)
    .filter(([k]) => k.startsWith('inngest.local.dispatched'))
    .reduce((s, [, v]) => s + v, 0);

  return (
    <Section
      title="Workflows"
      description="Last 24h Inngest run rollup + recent rows."
    >
      {inngestUnreachable ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <div>
            <strong className="font-semibold">
              Inngest delivery unavailable — running on in-process fallback.
            </strong>{' '}
            Workflow events are being dispatched locally without retries or
            durable <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">step.sleep</code>;
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">{fmtNumber(localDispatched)}</code>{' '}
            events handled this way so far. For production-grade durability run{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/40">
              pnpm inngest:dev
            </code>{' '}in a second terminal.
            {sendFailures > 0
              ? ` ${fmtNumber(sendFailures)} cloud send attempts failed before falling back.`
              : null}
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Total runs" value={fmtNumber(stats.totalRuns)} />
        <StatTile label="Succeeded" value={fmtNumber(stats.completed)} tone="success" />
        <StatTile
          label="Failed"
          value={fmtNumber(stats.failed)}
          tone={stats.failed > 0 ? 'danger' : 'default'}
        />
        <StatTile label="Skipped" value={fmtNumber(stats.skipped)} tone="muted" />
      </div>

      {longestStuck && stuckMs && stuckMs > 5 * 60 * 1000 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>Long-running run:</strong> {longestStuck.workflowId} has been
          running for {fmtDuration(stuckMs)}. Some workflows (e.g. `deal-won`)
          legitimately sleep multi-day; investigate only if duration is far
          beyond the workflow's expected schedule.
        </div>
      ) : null}

      {stats.byWorkflow.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            By workflow
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="py-1.5 pr-3">Workflow</th>
                  <th className="py-1.5 pr-3">Runs</th>
                  <th className="py-1.5 pr-3">Failed</th>
                  <th className="py-1.5 pr-3">Avg duration</th>
                </tr>
              </thead>
              <tbody>
                {stats.byWorkflow.map((row) => (
                  <tr
                    key={row.workflowId}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                  >
                    <td className="py-1.5 pr-3 font-medium">{row.workflowId}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{fmtNumber(row.runs)}</td>
                    <td
                      className={`py-1.5 pr-3 tabular-nums ${
                        row.failed > 0 ? 'text-red-600 dark:text-red-400' : ''
                      }`}
                    >
                      {fmtNumber(row.failed)}
                    </td>
                    <td className="py-1.5 pr-3 tabular-nums text-zinc-600 dark:text-zinc-400">
                      {fmtDuration(row.avgMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {spansEmbed ? (
        <div className="mt-3 text-[11px] text-zinc-500">
          In-process retrieval span p95: {fmtDuration(spansEmbed.p95)} (n=
          {spansEmbed.count})
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
          Recent runs
        </h3>
        {recent.length === 0 ? (
          <p className="text-xs text-zinc-500">No workflow runs recorded for this tenant yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                  <th className="py-1.5 pr-3">Started</th>
                  <th className="py-1.5 pr-3">Workflow</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Duration</th>
                  <th className="py-1.5 pr-3">Trigger</th>
                  <th className="py-1.5 pr-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => {
                  const dur =
                    row.completedAt
                      ? row.completedAt.getTime() - row.startedAt.getTime()
                      : null;
                  return (
                    <tr key={row.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="py-1.5 pr-3 text-zinc-500 tabular-nums">
                        {dateFormatter.format(new Date(row.startedAt))}
                      </td>
                      <td className="py-1.5 pr-3 font-medium">{row.workflowId}</td>
                      <td className="py-1.5 pr-3">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-zinc-600 dark:text-zinc-400">
                        {fmtDuration(dur)}
                      </td>
                      <td className="py-1.5 pr-3 text-zinc-500">{row.eventName ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-red-600 dark:text-red-400">
                        {row.error ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}
