import { AlertTriangle, ChevronRight } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Operations, collapsed to one line.
 *
 * The dashboard used to carry four full-size ops cards (Workflows, AI
 * calls, Email, Inbox) that duplicated /dashboard/ops wholesale. The
 * same four checks now run here and only claim real estate when one of
 * them is actually unhealthy — a healthy org gets a single muted row.
 *
 * Severity ladder: any `danger` check → banner treatment (amber/rose
 * border + list of what's wrong). Otherwise → one quiet line.
 */

export type OpsCheck = {
  label: string;
  /** Shown only when the check is degraded. */
  detail: string;
  severity: 'ok' | 'warning' | 'danger';
};

export function buildOpsChecks({
  workflowStats,
  aiStats,
  emailStats,
  inbox,
}: {
  workflowStats: { totalRuns: number; running: number; failed: number };
  aiStats: { totalCalls: number; errorCount: number };
  emailStats: { sent: number; failed: number; exhausted: number };
  inbox: { active: number; unread: number; failed: number };
}): OpsCheck[] {
  const aiErrorRate =
    aiStats.totalCalls > 0 ? aiStats.errorCount / aiStats.totalCalls : 0;
  return [
    {
      label: 'Workflows',
      detail: `${workflowStats.failed} failed run${workflowStats.failed === 1 ? '' : 's'}`,
      severity: workflowStats.failed > 0 ? 'danger' : 'ok',
    },
    {
      label: 'AI calls',
      detail: `${Math.round(aiErrorRate * 100)}% error rate`,
      severity:
        aiStats.errorCount > 0 && aiErrorRate > 0.1
          ? 'danger'
          : aiStats.errorCount > 0
            ? 'warning'
            : 'ok',
    },
    {
      label: 'Email',
      detail:
        emailStats.exhausted > 0
          ? `${emailStats.exhausted} exhausted retries`
          : `${emailStats.failed} retrying`,
      severity:
        emailStats.exhausted > 0
          ? 'danger'
          : emailStats.failed > 0
            ? 'warning'
            : 'ok',
    },
    {
      label: 'Inbox',
      // Unread mail is a person problem, not a platform problem — only
      // hard sync failures count as degraded here.
      detail: `${inbox.failed} failed thread${inbox.failed === 1 ? '' : 's'}`,
      severity: inbox.failed > 0 ? 'danger' : 'ok',
    },
  ];
}

export function OpsStatusStrip({
  checks,
  className,
}: {
  checks: OpsCheck[];
  className?: string;
}) {
  const degraded = checks.filter((c) => c.severity !== 'ok');
  const worst: OpsCheck['severity'] = degraded.some(
    (c) => c.severity === 'danger',
  )
    ? 'danger'
    : degraded.length > 0
      ? 'warning'
      : 'ok';

  const dotClass = {
    ok: 'bg-emerald-500',
    warning: 'bg-amber-500',
    danger: 'bg-rose-500',
  }[worst];

  if (worst === 'ok') {
    return (
      <section
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11.5px] shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]',
          className,
        )}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)} aria-hidden />
        <span className="text-slate-600 dark:text-[#A1A1AA]">
          All systems normal
        </span>
        <span className="text-slate-300 dark:text-[#3F3F46]">·</span>
        <span className="text-slate-400 dark:text-[#71717A]">
          workflows, AI, email, inbox · last 24h
        </span>
        <Link
          href="/dashboard/ops"
          className="ml-auto inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          View Operations <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </section>
    );
  }

  return (
    <section
      className={cn(
        'rounded-lg border px-3 py-2.5 text-[11.5px] shadow-[0_1px_0_rgba(15,23,42,0.04)]',
        worst === 'danger'
          ? 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10'
          : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            worst === 'danger'
              ? 'text-rose-600 dark:text-rose-300'
              : 'text-amber-600 dark:text-amber-300',
          )}
          aria-hidden
        />
        <span
          className={cn(
            'font-semibold',
            worst === 'danger'
              ? 'text-rose-800 dark:text-rose-200'
              : 'text-amber-900 dark:text-amber-200',
          )}
        >
          {degraded.length} of {checks.length} platform checks need attention
        </span>
        <Link
          href="/dashboard/ops"
          className="ml-auto inline-flex items-center gap-0.5 font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
        >
          View Operations <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-5.5 text-[11px]">
        {degraded.map((c) => (
          <li
            key={c.label}
            className={cn(
              'inline-flex items-center gap-1.5',
              c.severity === 'danger'
                ? 'text-rose-700 dark:text-rose-200'
                : 'text-amber-800 dark:text-amber-200',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                c.severity === 'danger' ? 'bg-rose-500' : 'bg-amber-500',
              )}
              aria-hidden
            />
            <span className="font-medium">{c.label}</span>
            <span className="opacity-80">{c.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
