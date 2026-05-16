'use client';

import { Workflow } from 'lucide-react';
import { useState } from 'react';

import type { WorkflowRun, WorkflowStatus } from '@/db/schema';
import { RelativeTime } from '@/lib/dates/relative-time';
import { cn } from '@/lib/utils';

import { WorkflowRunDrawer } from './workflow-run-drawer';

const STATUS_STYLES: Record<WorkflowStatus, string> = {
  running:
    'bg-blue-100 text-blue-700',
  completed:
    'bg-emerald-100 text-emerald-700',
  failed:
    'bg-red-100 text-red-700',
  skipped:
    'bg-slate-100 text-slate-700',
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function WorkflowRunsList({ rows }: { rows: WorkflowRun[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? rows.find((r) => r.id === selectedId) ?? null : null;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
        <Workflow className="mx-auto h-9 w-9 text-slate-400" aria-hidden />
        <h3 className="mt-3 text-sm font-semibold text-slate-700">
          No workflow runs yet
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
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
    <>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
            <thead className="sticky top-0 z-10 bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500 backdrop-blur">
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
            <tbody className="divide-y divide-slate-200">
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
                const source =
                  meta.source === 'local'
                    ? 'local'
                    : meta.source === 'inngest'
                      ? 'inngest'
                      : null;
                return (
                  <tr
                    key={run.id}
                    onClick={() => setSelectedId(run.id)}
                    className="cursor-pointer transition-colors hover:bg-slate-50/70"
                  >
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
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-600',
                            )}
                          >
                            {source}
                          </span>
                        ) : null}
                      </div>
                      {run.error ? (
                        <div className="mt-1 truncate text-xs text-red-600">
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
                    <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">
                      <span className="font-mono text-xs">
                        {run.eventName ?? '—'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500">
                      <div><RelativeTime date={run.startedAt} /></div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {dateFormatter.format(run.startedAt)}
                      </div>
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs text-slate-500 md:table-cell">
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

      <WorkflowRunDrawer
        run={selected}
        onClose={() => setSelectedId(null)}
      />
    </>
  );
}
