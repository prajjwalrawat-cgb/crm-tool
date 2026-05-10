import type { MetricsSnapshot } from '@/lib/observability';

import { fmtDuration, fmtNumber, Section, StatTile } from './primitives';

export function RealtimeSection({ metrics }: { metrics: MetricsSnapshot }) {
  const open = metrics.gauges['sse.connections'] ?? 0;
  const opens = metrics.counters['sse.opens'] ?? 0;
  const tenantOpens = Object.entries(metrics.counters)
    .filter(([k]) => k.startsWith('sse.opens{'))
    .map(([k, v]) => ({ label: k, count: v }));
  const dispatched = Object.entries(metrics.counters)
    .filter(([k]) => k.startsWith('realtime.events_dispatched'))
    .reduce((s, [, v]) => s + v, 0);
  const lifetime = metrics.histograms['sse.connection_lifetime_ms'];
  const unauth = metrics.counters['sse.unauthenticated'] ?? 0;

  return (
    <Section
      title="Realtime / SSE"
      description="In-memory counters from this Node instance only — multi-instance deploys would aggregate."
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Open now" value={fmtNumber(open)} hint="across tenants" />
        <StatTile
          label="Total opens"
          value={fmtNumber(opens)}
          hint="since process boot"
        />
        <StatTile
          label="Events dispatched"
          value={fmtNumber(dispatched)}
          hint="NOTIFY → SSE"
        />
        <StatTile
          label="Avg lifetime"
          value={lifetime ? fmtDuration(lifetime.avg) : '—'}
          hint={lifetime ? `p95 ${fmtDuration(lifetime.p95)}` : 'no closed streams yet'}
        />
      </div>

      {unauth > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
          {fmtNumber(unauth)} unauthenticated SSE connection attempts in this
          process. Expected during routine sign-out, but a sudden spike is
          worth investigating.
        </div>
      ) : null}

      {tenantOpens.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Per-tenant opens
          </h3>
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {tenantOpens.slice(0, 8).map((row) => (
              <li
                key={row.label}
                className="flex items-center justify-between rounded-md border border-zinc-200 px-2 py-1 font-mono text-[11px] dark:border-zinc-800"
              >
                <span className="truncate text-zinc-500">{row.label}</span>
                <span className="ml-2 tabular-nums">{fmtNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
