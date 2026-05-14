'use client';

import { AlertTriangle, CheckCircle2, Clock, Cpu, Radio } from 'lucide-react';
import Link from 'next/link';

import type { WorkflowRun, WorkflowStatus } from '@/db/schema';
import { cn } from '@/lib/utils';

import { Drawer } from '../../_components/drawer';

const STATUS_TINT: Record<WorkflowStatus, string> = {
  running: 'bg-blue-100 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-100 text-red-700 ring-red-200',
  skipped: 'bg-slate-100 text-slate-600 ring-slate-200',
};

const absoluteFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

const ENTITY_HREF: Record<string, (id: string) => string> = {
  deal: (id) => `/dashboard/deals/${id}`,
  company: (id) => `/dashboard/companies/${id}`,
  contact: (id) => `/dashboard/contacts/${id}`,
};

/**
 * Detail drawer for a workflow run. Renders the execution timeline
 * (queued → started → completed/failed), source clarity (local vs
 * inngest), linked entity (deal/company/contact) when the metadata
 * carries it, and a formatted JSON payload viewer for everything else.
 *
 * Keeps to the existing `WorkflowRun` row shape — no schema migration.
 * If we later add `payload`, `retries`, `attempts` columns this drawer
 * is the rendering surface for them.
 */
export function WorkflowRunDrawer({
  run,
  onClose,
}: {
  run: WorkflowRun | null;
  onClose: () => void;
}) {
  const open = run !== null;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={run?.workflowId ?? 'Workflow run'}
      description={run?.eventName ?? undefined}
    >
      {run ? <DrawerBody run={run} /> : null}
    </Drawer>
  );
}

function DrawerBody({ run }: { run: WorkflowRun }) {
  const status = (run.status as WorkflowStatus) ?? 'running';
  const meta = (run.metadata ?? {}) as Record<string, unknown>;
  const source =
    meta.source === 'local'
      ? 'local'
      : meta.source === 'inngest'
        ? 'inngest'
        : null;

  const duration =
    run.completedAt && run.startedAt
      ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime())
      : null;

  // Pull entity refs out of metadata for a "Related" link.
  const linkedEntity = extractEntityRef(meta);

  return (
    <div className="space-y-4">
      {/* Status + source banner */}
      <section className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ring-1',
            STATUS_TINT[status],
          )}
        >
          <StatusDot status={status} />
          {status}
        </span>
        {source ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide ring-1',
              source === 'local'
                ? 'bg-amber-50 text-amber-800 ring-amber-200'
                : 'bg-slate-50 text-slate-700 ring-slate-200',
            )}
            title={
              source === 'local'
                ? 'In-process fallback dispatcher (no retries, sleeps skipped)'
                : 'Real Inngest cloud dispatch'
            }
          >
            {source === 'local' ? <Cpu className="h-3 w-3" aria-hidden /> : <Radio className="h-3 w-3" aria-hidden />}
            {source}
          </span>
        ) : null}
        <span className="font-mono text-[10.5px] text-slate-500">
          run {run.id.slice(0, 8)}
        </span>
      </section>

      {run.error ? (
        <section className="rounded-md border border-red-200 bg-red-50/70 p-3 text-[12.5px] text-red-800">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Failure reason
          </div>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-snug">
            {run.error}
          </pre>
        </section>
      ) : null}

      {/* Execution timeline */}
      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          Execution timeline
        </h3>
        <ol className="relative space-y-2 border-l border-slate-200 pl-4">
          <TimelinePoint
            tone="indigo"
            label="Started"
            when={run.startedAt}
            sub={run.eventName ? `event ${run.eventName}` : undefined}
          />
          {run.completedAt ? (
            <TimelinePoint
              tone={status === 'failed' ? 'rose' : 'emerald'}
              label={
                status === 'failed'
                  ? 'Failed'
                  : status === 'skipped'
                    ? 'Skipped'
                    : 'Completed'
              }
              when={run.completedAt}
              sub={
                duration !== null
                  ? duration < 1000
                    ? `${duration}ms`
                    : `${(duration / 1000).toFixed(1)}s elapsed`
                  : undefined
              }
            />
          ) : (
            <TimelinePoint
              tone="slate"
              label="In flight"
              when={null}
              sub="No completion timestamp yet"
            />
          )}
        </ol>
      </section>

      {/* Related entity */}
      {linkedEntity ? (
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
            Related entity
          </h3>
          <Link
            href={ENTITY_HREF[linkedEntity.type]?.(linkedEntity.id) ?? '#'}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700"
          >
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              {linkedEntity.type}
            </span>
            <span className="font-mono text-[11px]">{linkedEntity.id.slice(0, 8)}…</span>
            {linkedEntity.label ? (
              <span className="truncate">{linkedEntity.label}</span>
            ) : null}
          </Link>
        </section>
      ) : null}

      {/* Metadata / payload inspector */}
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
          <Clock className="h-3 w-3" aria-hidden />
          Payload
        </h3>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50">
          <pre className="max-h-[26rem] overflow-auto px-3 py-2 text-[11px] leading-snug">
            {JSON.stringify(run.metadata ?? {}, null, 2)}
          </pre>
        </div>
        <p className="mt-1 text-[10.5px] text-slate-500">
          Inngest run id:{' '}
          <span className="font-mono">{run.inngestRunId ?? '(local)'}</span>
        </p>
      </section>
    </div>
  );
}

function StatusDot({ status }: { status: WorkflowStatus }) {
  if (status === 'completed') return <CheckCircle2 className="h-3 w-3" aria-hidden />;
  if (status === 'failed') return <AlertTriangle className="h-3 w-3" aria-hidden />;
  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full',
        status === 'running' ? 'animate-pulse bg-current' : 'bg-current',
      )}
      aria-hidden
    />
  );
}

function TimelinePoint({
  tone,
  label,
  when,
  sub,
}: {
  tone: 'indigo' | 'emerald' | 'rose' | 'slate';
  label: string;
  when: Date | null;
  sub?: string;
}) {
  const dotClass: Record<typeof tone, string> = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    rose: 'bg-rose-500',
    slate: 'bg-slate-400',
  };
  return (
    <li className="relative">
      <span
        className={cn(
          'absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-white',
          dotClass[tone],
        )}
        aria-hidden
      />
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-slate-700">{label}</span>
        {when ? (
          <span className="font-mono text-[10.5px] text-slate-500">
            {absoluteFormatter.format(when)}
          </span>
        ) : null}
      </div>
      {sub ? <p className="text-[11px] text-slate-500">{sub}</p> : null}
    </li>
  );
}

function extractEntityRef(
  meta: Record<string, unknown>,
): { type: string; id: string; label?: string } | null {
  // Best-effort metadata sniffing — the workflows write different shapes.
  for (const [type, key] of [
    ['deal', 'dealId'],
    ['company', 'companyId'],
    ['contact', 'contactId'],
  ] as const) {
    const v = meta[key];
    if (typeof v === 'string' && v.length > 0) {
      const labelKey = `${type}Name` as const;
      const label =
        typeof meta[labelKey] === 'string' ? (meta[labelKey] as string) : undefined;
      return { type, id: v, label };
    }
  }
  // Generic { entityType, entityId } shape used by `regenerate-embedding`.
  const t = meta.entityType;
  const i = meta.entityId;
  if (typeof t === 'string' && typeof i === 'string' && i.length > 0) {
    return { type: t, id: i };
  }
  return null;
}
