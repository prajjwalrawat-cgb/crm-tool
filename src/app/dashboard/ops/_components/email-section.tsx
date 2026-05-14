import { AlertTriangle, Mail, RotateCw } from 'lucide-react';

import type { EmailDeliveryStats } from '@/lib/ops/queries';
import { formatRelativeTime } from '@/lib/activity/format';
import { cn } from '@/lib/utils';

import { Section, StatTile } from './primitives';

/**
 * Email delivery health card. Renders the queued → sent/failed funnel
 * for the last `windowHours`, plus a "needs attention" list of recent
 * failures with their retry posture (retryable vs exhausted).
 *
 * Designed to answer the operator question: "are my outbound emails
 * actually leaving the system right now?"
 */
export function EmailSection({ stats }: { stats: EmailDeliveryStats }) {
  const successRate =
    stats.total === 0
      ? null
      : Math.round(((stats.sent + stats.delivered) / stats.total) * 100);

  const healthTone = (() => {
    if (stats.total === 0) return 'muted';
    if (stats.failed === 0) return 'success';
    if (stats.retryable > 0 || (successRate ?? 100) < 95) return 'warn';
    return 'danger';
  })() as 'success' | 'warn' | 'danger' | 'muted';

  return (
    <Section
      title="Email delivery"
      description={`Outbound email health over the last ${stats.windowHours}h.`}
      action={
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1',
            healthTone === 'success' && 'bg-emerald-50 text-emerald-700 ring-emerald-200',
            healthTone === 'warn' && 'bg-amber-50 text-amber-800 ring-amber-200',
            healthTone === 'danger' && 'bg-rose-50 text-rose-700 ring-rose-200',
            healthTone === 'muted' && 'bg-slate-50 text-slate-600 ring-slate-200',
          )}
        >
          <Mail className="h-3 w-3" aria-hidden />
          {healthTone === 'success'
            ? 'Healthy'
            : healthTone === 'warn'
              ? 'Degraded'
              : healthTone === 'danger'
                ? 'Failing'
                : 'Idle'}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label="Sent"
          value={stats.sent + stats.delivered}
          hint={successRate === null ? '—' : `${successRate}% success`}
          tone="success"
        />
        <StatTile
          label="Queued"
          value={stats.queued + stats.sending}
          hint={stats.sending > 0 ? `${stats.sending} in flight` : 'Idle'}
          tone={stats.queued + stats.sending > 0 ? 'warn' : 'muted'}
        />
        <StatTile
          label="Failed"
          value={stats.failed}
          hint={`${stats.retryable} retryable · ${stats.exhausted} exhausted`}
          tone={stats.failed > 0 ? 'danger' : 'muted'}
        />
        <StatTile
          label="Volume"
          value={stats.total}
          hint={`${stats.windowHours}h window`}
        />
      </div>

      {stats.byProvider.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            By provider
          </h3>
          <ul className="space-y-1 text-[12px]">
            {stats.byProvider.map((p) => (
              <li
                key={p.provider}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50/60 px-2.5 py-1.5"
              >
                <span className="font-mono text-[11px]">{p.provider}</span>
                <span className="text-slate-600">
                  {p.count} sent
                  {p.failed > 0 ? (
                    <span className="ml-2 text-rose-600">· {p.failed} failed</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {stats.recentFailures.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-500">
            <AlertTriangle className="h-3 w-3 text-rose-500" aria-hidden />
            Recent failures
          </h3>
          <ul className="space-y-1.5">
            {stats.recentFailures.map((f) => (
              <li
                key={f.id}
                className="rounded-md border border-rose-200 bg-rose-50/50 px-2.5 py-2 text-[12px]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-slate-800">
                    {f.subject || '(no subject)'}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">
                    {formatRelativeTime(f.createdAt)}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-600">
                  to{' '}
                  <span className="font-mono">{f.recipientLabel}</span>{' '}
                  · {f.provider} · {f.retryCount}/3 retries
                </div>
                {f.error ? (
                  <p className="mt-0.5 truncate font-mono text-[10.5px] text-rose-700">
                    {f.error}
                  </p>
                ) : null}
                {f.retryCount < 3 ? (
                  <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-amber-700">
                    <RotateCw className="h-3 w-3" aria-hidden />
                    Eligible for retry
                  </p>
                ) : (
                  <p className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-rose-700">
                    Retry budget exhausted — manual intervention required
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
