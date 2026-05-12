import { Sparkles, AlertTriangle } from 'lucide-react';

import type { AIMode } from '@/lib/ai/config';
import type { MetricsSnapshot } from '@/lib/observability';
import type { AIInvocationRow, AIInvocationStats } from '@/lib/ops/queries';

import { fmtDuration, fmtNumber, Section, StatTile, StatusPill } from './primitives';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

const modeBlurb: Record<AIMode, string> = {
  live: 'Live OpenAI mode. Audit rows reflect real billed token counts.',
  mock: 'AI_ENABLED=false. Embeddings + completions are deterministic stubs; audit rows record intended (estimated) token counts.',
  disabled: 'AI_ENABLED=true but OPENAI_API_KEY is missing or empty. The platform is treating this like mock mode at the call sites; treat it like a misconfiguration.',
};

export function AiSection({
  mode,
  stats,
  recent,
  metrics,
}: {
  mode: AIMode;
  stats: AIInvocationStats;
  recent: AIInvocationRow[];
  metrics: MetricsSnapshot;
}) {
  const banner =
    mode === 'live'
      ? null
      : mode === 'disabled'
        ? {
            tone: 'danger' as const,
            label: 'AI misconfigured',
            text: modeBlurb.disabled,
          }
        : {
            tone: 'warn' as const,
            label: 'Mock AI mode',
            text: modeBlurb.mock,
          };

  const retrievedHist = metrics.histograms['ai.chat.retrieved_records'];
  const chatLatency = metrics.histograms['ai.chat.duration_ms'];

  return (
    <Section
      title="AI"
      description="Last 24h aggregated from ai_invocations + live in-process metrics."
      action={
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
          <Sparkles className="h-3 w-3" aria-hidden /> {mode}
        </span>
      }
    >
      {banner ? (
        <div
          className={`mb-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
            banner.tone === 'danger'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
          <div>
            <strong className="font-semibold">{banner.label}.</strong>{' '}
            {banner.text}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Successful" value={fmtNumber(stats.successCount)} tone="success" />
        <StatTile label="Skipped (mock/cached)" value={fmtNumber(stats.skippedCount)} tone="muted" />
        <StatTile label="Errors" value={fmtNumber(stats.errorCount)} tone={stats.errorCount > 0 ? 'danger' : 'default'} />
        <StatTile label="Tokens" value={fmtNumber(stats.totalTokens)} tone="muted" />
      </div>

      {stats.byKind.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            By kind
          </h3>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {stats.byKind.map((row) => (
              <div
                key={row.kind}
                className="rounded-md border border-slate-200 px-2 py-1.5 text-xs"
              >
                <div className="font-medium">{row.kind}</div>
                <div className="text-slate-500">
                  {fmtNumber(row.count)} calls · {fmtNumber(row.tokens)} tok
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {chatLatency || retrievedHist ? (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {chatLatency ? (
            <StatTile
              label="Chat p95"
              value={fmtDuration(chatLatency.p95)}
              hint={`p50 ${fmtDuration(chatLatency.p50)} · max ${fmtDuration(chatLatency.max)}`}
            />
          ) : null}
          {retrievedHist ? (
            <StatTile
              label="Retrieved records (avg)"
              value={retrievedHist.avg.toFixed(1)}
              hint={`p95 ${retrievedHist.p95.toFixed(0)} · n=${retrievedHist.count}`}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Recent invocations
        </h3>
        {recent.length === 0 ? (
          <p className="text-xs text-slate-500">No AI invocations recorded for this tenant yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-3">Time</th>
                  <th className="py-1.5 pr-3">Kind</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Tokens</th>
                  <th className="py-1.5 pr-3">Latency</th>
                  <th className="py-1.5 pr-3">Model</th>
                  <th className="py-1.5 pr-3">Error / mode</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => {
                  const meta = (row.metadata ?? {}) as { mode?: string; mock?: boolean };
                  return (
                    <tr key={row.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 text-slate-500 tabular-nums">
                        {dateFormatter.format(new Date(row.createdAt))}
                      </td>
                      <td className="py-1.5 pr-3 font-medium">{row.kind}</td>
                      <td className="py-1.5 pr-3">
                        <StatusPill status={row.status} />
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-600">
                        {fmtNumber(row.totalTokens)}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-600">
                        {fmtDuration(row.latencyMs)}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600">{row.model}</td>
                      <td className="py-1.5 pr-3 text-slate-500">
                        {row.error
                          ? <span className="text-red-600">{row.error}</span>
                          : meta.mode ?? '—'}
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
