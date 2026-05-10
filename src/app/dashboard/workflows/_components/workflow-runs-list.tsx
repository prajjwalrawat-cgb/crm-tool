import { Workflow } from 'lucide-react';

import type { WorkflowRun, WorkflowStatus } from '@/db/schema';
import { formatRelativeTime } from '@/lib/activity/format';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<WorkflowStatus, string> = {
  running:
    'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  completed:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  failed:
    'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
  skipped:
    'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function WorkflowRunsList({ rows }: { rows: WorkflowRun[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <Workflow
          className="mx-auto h-9 w-9 text-zinc-400"
          aria-hidden
        />
        <h3 className="mt-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          No workflow runs yet
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs text-zinc-500 dark:text-zinc-400">
          Workflows fire on stage changes (won, lost), member invites, and a
          daily stale-deals cron. Move a deal to <span className="font-medium">won</span>{' '}
          or <span className="font-medium">lost</span> to trigger the first
          run, or check <span className="font-medium">/dashboard/ops</span> if
          you expect events but see none.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="sticky top-0 z-10 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-950">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Workflow
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Status
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-left font-medium sm:table-cell"
              >
                Trigger
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Started
              </th>
              <th
                scope="col"
                className="hidden px-3 py-2 text-right font-medium md:table-cell"
              >
                Duration
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((run) => {
              const status = (run.status as WorkflowStatus) ?? 'running';
              const duration =
                run.completedAt && run.startedAt
                  ? Math.max(
                      0,
                      run.completedAt.getTime() - run.startedAt.getTime(),
                    )
                  : null;
              const meta = (run.metadata ?? {}) as { source?: string };
              const source = meta.source === 'local' ? 'local' : meta.source === 'inngest' ? 'inngest' : null;
              return (
                <tr key={run.id}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{run.workflowId}</span>
                      {source ? (
                        <span
                          title={
                            source === 'local'
                              ? 'In-process fallback (no retries / sleep skipped)'
                              : 'Real Inngest dispatch'
                          }
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                            source === 'local'
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                          )}
                        >
                          {source}
                        </span>
                      ) : null}
                    </div>
                    {run.error ? (
                      <div className="mt-1 text-xs text-red-600 dark:text-red-400">
                        {run.error}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
                        STATUS_STYLES[status],
                      )}
                    >
                      {status}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2 text-zinc-600 sm:table-cell dark:text-zinc-400">
                    <span className="font-mono text-xs">
                      {run.eventName ?? '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-zinc-500">
                    <div>{formatRelativeTime(run.startedAt)}</div>
                    <div className="font-mono text-[10px] text-zinc-400">
                      {dateFormatter.format(run.startedAt)}
                    </div>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-zinc-500 md:table-cell">
                    {duration === null
                      ? '…'
                      : duration < 1000
                        ? `${duration}ms`
                        : `${Math.round(duration / 1000)}s`}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
