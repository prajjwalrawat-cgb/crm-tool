import type { LogEntry } from '@/lib/observability';

import { Section } from './primitives';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function LogsSection({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return (
      <Section
        title="Recent logs"
        description="Live tail from this Node process."
      >
        <p className="text-xs text-slate-500">No log entries on this process yet.</p>
      </Section>
    );
  }
  return (
    <Section
      title="Recent logs"
      description={`Live tail (${logs.length}) from this Node process.`}
    >
      <ul className="flex flex-col gap-1 font-mono text-[11px]">
        {logs.slice(0, 80).map((entry, i) => {
          const tone =
            entry.level === 'error'
              ? 'text-red-600'
              : entry.level === 'warn'
                ? 'text-amber-600'
                : entry.level === 'debug'
                  ? 'text-slate-400'
                  : 'text-slate-700';
          return (
            <li
              key={`${entry.timestamp}-${i}`}
              className="grid grid-cols-[auto_auto_auto_1fr] gap-2 border-b border-slate-100 py-0.5 last:border-0"
            >
              <span className="text-slate-400">
                {dateFormatter.format(new Date(entry.timestamp))}
              </span>
              <span className={`font-semibold uppercase ${tone}`}>
                {entry.level}
              </span>
              <span className="text-slate-400">
                {entry.traceId ? entry.traceId.slice(0, 8) : '--------'}
              </span>
              <span className="break-words">{entry.message}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
