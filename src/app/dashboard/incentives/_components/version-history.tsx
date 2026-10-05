import { termLabel, type TermKey } from '@/lib/incentives/terms';
import type { VersionView } from '@/lib/incentives/types';

const ACTION_LABEL: Record<string, string> = {
  created: 'Created',
  updated: 'Edited',
  bulk_updated: 'Bulk change',
  status_changed: 'Status changed',
  actuals_source_changed: 'Actuals source changed',
};

const EXTRA_LABEL: Record<string, string> = { status: 'Status', actualsSource: 'Actuals source' };

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/** The append-only plan audit trail: who changed what, when. */
export function VersionHistory({ versions, names }: { versions: VersionView[]; names: Record<string, string> }) {
  return (
    <ol className="space-y-3">
      {versions.map((v) => {
        const entries = Object.entries(v.changes);
        return (
          <li key={v.version} className="border-l-2 border-slate-200 pl-3 dark:border-[#2A2A2A]">
            <div className="text-[12px] text-slate-700 dark:text-[#D4D4D8]">
              <span className="font-semibold">v{v.version}</span> · {ACTION_LABEL[v.action] ?? v.action} by{' '}
              {v.changedBy ? (names[v.changedBy] ?? v.changedBy) : 'System'}
            </div>
            <div className="text-[11px] text-slate-400 dark:text-[#71717A]">
              {new Date(v.changedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
            {entries.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-[12px] text-slate-600 dark:text-[#A1A1AA]">
                {entries.map(([k, c]) => (
                  <li key={k}>
                    {EXTRA_LABEL[k] ?? termLabel(k as TermKey)}: {show(c.from)} → <strong>{show(c.to)}</strong>
                  </li>
                ))}
              </ul>
            ) : null}
            {v.note ? <p className="mt-1 text-[12px] italic text-slate-500">“{v.note}”</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
