import type { ErrorEntry } from '@/lib/observability';

import { Section, StatusPill } from './primitives';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function ErrorsSection({ errors }: { errors: ErrorEntry[] }) {
  if (errors.length === 0) {
    return (
      <Section
        title="Errors"
        description="In-process error capture. Cleared on restart."
      >
        <p className="text-xs text-slate-500">No errors captured on this Node process.</p>
      </Section>
    );
  }
  return (
    <Section
      title="Errors"
      description={`Last ${errors.length} captured in this process. Severity high/fatal first.`}
    >
      <ul className="flex flex-col gap-2 text-xs">
        {errors.slice(0, 25).map((err, i) => {
          const tone =
            err.severity === 'fatal'
              ? 'border-red-300 bg-red-50'
              : err.severity === 'high'
                ? 'border-amber-300 bg-amber-50'
                : 'border-slate-200 bg-slate-50';
          return (
            <li
              key={`${err.capturedAt}-${i}`}
              className={`rounded-md border px-3 py-2 ${tone}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono text-slate-500">
                  {dateFormatter.format(new Date(err.capturedAt))}
                </span>
                <StatusPill status={err.severity} />
                <span className="font-medium">{err.category}</span>
                {err.retryable ? (
                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-blue-700">
                    retryable
                  </span>
                ) : null}
                {err.traceId ? (
                  <span className="font-mono text-[10px] text-slate-400">
                    trace={err.traceId.slice(0, 8)}
                  </span>
                ) : null}
                {err.tenantId ? (
                  <span className="font-mono text-[10px] text-slate-400">
                    tenant={err.tenantId.slice(0, 8)}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 break-words text-slate-700">
                {err.message}
              </p>
              {err.fields && Object.keys(err.fields).length > 0 ? (
                <pre className="mt-1 overflow-x-auto font-mono text-[10px] text-slate-500">
                  {JSON.stringify(err.fields, null, 2)}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
