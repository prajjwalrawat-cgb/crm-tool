import { AlertTriangle, Bell, Workflow } from 'lucide-react';

import type { ErrorEntry } from '@/lib/observability';
import type { EmailDeliveryStats, WorkflowStats } from '@/lib/ops/queries';
import { cn } from '@/lib/utils';

import { Section, StatTile } from './primitives';

/**
 * Cross-cutting "is the automation layer healthy?" card. Aggregates
 * three signals operators care about together:
 *
 *   1. Notification publish failures captured by recordNotificationSafe
 *      (from the in-process error capture buffer)
 *   2. Workflow failure rate (from the workflows stats query)
 *   3. Email retry-queue depth (from the email stats query)
 *
 * Sits above the more-detailed per-domain sections so an operator can
 * answer "is anything on fire?" without scrolling.
 */
export function AutomationHealthSection({
  errors,
  runStats,
  emailStats,
}: {
  errors: ErrorEntry[];
  runStats: WorkflowStats;
  emailStats: EmailDeliveryStats;
}) {
  const notificationFailures = errors.filter(
    (e) => e.category === 'notification.publish_failed',
  );
  const workflowFailureRate =
    runStats.totalRuns === 0
      ? 0
      : Math.round((runStats.failed / runStats.totalRuns) * 100);
  const retryBacklog = emailStats.retryable + emailStats.exhausted;

  const banner: 'success' | 'warn' | 'danger' = (() => {
    if (
      notificationFailures.length === 0 &&
      runStats.failed === 0 &&
      emailStats.exhausted === 0
    ) {
      return 'success';
    }
    if (
      notificationFailures.length > 5 ||
      workflowFailureRate > 25 ||
      emailStats.exhausted > 0
    ) {
      return 'danger';
    }
    return 'warn';
  })();

  return (
    <Section
      title="Automation health"
      description="Cross-cutting view of the automation, notification, and email layers."
      action={
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1',
            banner === 'success' && 'bg-emerald-50 text-emerald-700 ring-emerald-200',
            banner === 'warn' && 'bg-amber-50 text-amber-800 ring-amber-200',
            banner === 'danger' && 'bg-rose-50 text-rose-700 ring-rose-200',
          )}
        >
          {banner === 'success'
            ? 'All systems normal'
            : banner === 'warn'
              ? 'Watch'
              : 'Needs attention'}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile
          label="Notification failures"
          value={notificationFailures.length}
          hint={
            notificationFailures.length === 0
              ? 'Healthy'
              : 'In-process buffer · clears on restart'
          }
          tone={notificationFailures.length === 0 ? 'success' : 'warn'}
        />
        <StatTile
          label="Workflow failure rate"
          value={`${workflowFailureRate}%`}
          hint={`${runStats.failed} of ${runStats.totalRuns} runs · last 24h`}
          tone={
            runStats.failed === 0
              ? 'success'
              : workflowFailureRate > 25
                ? 'danger'
                : 'warn'
          }
        />
        <StatTile
          label="Email retry backlog"
          value={retryBacklog}
          hint={
            emailStats.exhausted > 0
              ? `${emailStats.exhausted} exhausted retries`
              : `${emailStats.retryable} retryable · last 24h`
          }
          tone={emailStats.exhausted > 0 ? 'danger' : retryBacklog > 0 ? 'warn' : 'success'}
        />
      </div>

      {notificationFailures.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            <Bell className="h-3 w-3" aria-hidden />
            Recent notification publish failures
          </div>
          <ul className="space-y-1 text-[11.5px] text-amber-900">
            {notificationFailures.slice(0, 4).map((e, i) => (
              <li
                key={`${e.capturedAt}-${i}`}
                className="flex items-start gap-1.5 leading-tight"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate font-mono">{e.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10.5px] text-amber-700">
            These failures are caught by the safe-notification wrapper and never
            break the underlying business action. They&apos;re logged here for
            triage only.
          </p>
        </div>
      ) : null}

      {runStats.failed > 0 ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Workflow className="h-3 w-3 text-slate-400" aria-hidden />
          Inspect failed runs in the Workflows tab — failures don&apos;t
          auto-retry beyond the default Inngest backoff.
        </div>
      ) : null}
    </Section>
  );
}
