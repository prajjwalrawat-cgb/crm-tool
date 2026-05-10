import type { HistogramSummary, MetricsSnapshot } from '@/lib/observability';

import { fmtDuration, fmtNumber, Section } from './primitives';

export function LatencySection({ metrics }: { metrics: MetricsSnapshot }) {
  const latencyKeys = Object.keys(metrics.histograms)
    .filter(
      (k) =>
        k.endsWith('_ms') ||
        k.endsWith('duration_ms') ||
        k.startsWith('span.duration_ms'),
    )
    .sort((a, b) => {
      // Sort by p95 descending so slow ops jump to the top.
      const av = metrics.histograms[a]?.p95 ?? 0;
      const bv = metrics.histograms[b]?.p95 ?? 0;
      return bv - av;
    });

  if (latencyKeys.length === 0) {
    return (
      <Section
        title="Latency"
        description="No latency samples on this process yet."
      >
        <p className="text-xs text-zinc-500">
          Histograms populate as traffic flows through the AI route, SSE
          stream, and workflows.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Latency"
      description="Histograms from this Node process. Sorted by p95 (worst first)."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="py-1.5 pr-3">Metric</th>
              <th className="py-1.5 pr-3">Count</th>
              <th className="py-1.5 pr-3">p50</th>
              <th className="py-1.5 pr-3">p95</th>
              <th className="py-1.5 pr-3">p99</th>
              <th className="py-1.5 pr-3">Max</th>
              <th className="py-1.5 pr-3">Avg</th>
            </tr>
          </thead>
          <tbody>
            {latencyKeys.slice(0, 20).map((key) => {
              const h = metrics.histograms[key] as HistogramSummary;
              return (
                <tr
                  key={key}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
                >
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                    {key}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtNumber(h.count)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtDuration(h.p50)}</td>
                  <td className="py-1.5 pr-3 tabular-nums font-medium">
                    {fmtDuration(h.p95)}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtDuration(h.p99)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtDuration(h.max)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{fmtDuration(h.avg)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
