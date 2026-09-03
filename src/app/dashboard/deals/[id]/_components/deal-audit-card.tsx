'use client';

import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  ScrollText,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import { formatCurrency, fromMinorUnits } from '@/lib/deals/currency';
import { DEAL_STAGE_LABELS, type DealStage } from '@/lib/deals/schema';
import { formatSlipDate } from '@/lib/deals/slip';
import {
  AUDIT_CHANGE_TYPE_LABELS,
  AUDIT_FIELD_LABELS,
  type AuditChangeType,
  rollbackReasonLabel,
} from '@/lib/deals/stage-governance';
import { cn } from '@/lib/utils';

type AuditEntry = {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: string;
  reasonCode: string | null;
  reasonNote: string | null;
};

type AuditResponse = {
  currency: string;
  entries: AuditEntry[];
  nextCursor: string | null;
};

const stamp = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Per-change-type chip colors. Rollback matches the board's violet badge. */
function changeTypeClass(t: string): string {
  switch (t) {
    case 'rollback':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300';
    case 'pushback':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300';
    case 'forward_progress':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
    default:
      return 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300';
  }
}

/**
 * Renders a stored value for the field it belongs to. The audit log stores
 * everything as text (one column spans an enum, a date and a bigint), so the
 * formatting has to be re-applied here rather than read off a typed column.
 */
function renderValue(
  field: string,
  raw: string | null,
  currency: string,
): string {
  if (raw == null || raw === '') return '—';
  if (field === 'stage') return DEAL_STAGE_LABELS[raw as DealStage] ?? raw;
  if (field === 'expected_close_date') return formatSlipDate(raw);
  if (field === 'amount_minor') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    return formatCurrency(fromMinorUnits(n, currency), currency);
  }
  return raw;
}

/**
 * The deal's governance audit trail (R5) — every change to stage, close date
 * and amount, newest first, with who and why.
 *
 * Collapsed by default and fetched on expand, matching the Date history
 * section: most visits to a deal never open it, and the log is unbounded, so
 * paying for it on every page render would be a poor trade.
 *
 * Read-only by construction — the rows are written by a DB trigger and the
 * table rejects UPDATEs, so there is deliberately no edit affordance here.
 */
export function DealAuditCard({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [currency, setCurrency] = useState('INR');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const url = after
          ? `/api/deals/${dealId}/audit-log?cursor=${encodeURIComponent(after)}`
          : `/api/deals/${dealId}/audit-log`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as AuditResponse;
        setCurrency(data.currency);
        // Append on "load more", replace on first open.
        setEntries((prev) => (after && prev ? [...prev, ...data.entries] : data.entries));
        setCursor(data.nextCursor);
      } catch {
        setError('Could not load the audit trail.');
      } finally {
        setLoading(false);
      }
    },
    [dealId],
  );

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && entries === null && !loading) void load(null);
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
          <ScrollText className="h-3.5 w-3.5" aria-hidden />
          Audit trail
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        )}
      </button>

      {open ? (
        <div className="border-t border-slate-100 px-3 py-2.5 dark:border-[#1F1F1F]">
          {loading && entries === null ? (
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Loading…
            </p>
          ) : error ? (
            <p className="text-xs text-red-600">{error}</p>
          ) : entries && entries.length === 0 ? (
            <p className="text-xs text-slate-500">
              No stage, close-date or amount changes recorded yet.
            </p>
          ) : (
            <>
              <ul className="space-y-2.5">
                {entries?.map((e) => (
                  <li key={e.id} className="text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          'inline-flex h-4 items-center rounded-full px-1.5 text-[10px] font-semibold',
                          changeTypeClass(e.changeType),
                        )}
                      >
                        {AUDIT_CHANGE_TYPE_LABELS[
                          e.changeType as AuditChangeType
                        ] ?? e.changeType}
                      </span>
                      <span className="font-medium text-slate-700 dark:text-[#D4D4D8]">
                        {AUDIT_FIELD_LABELS[e.fieldName] ?? e.fieldName}
                      </span>
                      <span className="flex items-center gap-1 tabular-nums text-slate-600 dark:text-[#A1A1AA]">
                        {renderValue(e.fieldName, e.oldValue, currency)}
                        <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                        <span className="font-medium text-slate-800 dark:text-[#FAFAFA]">
                          {renderValue(e.fieldName, e.newValue, currency)}
                        </span>
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {e.changedByName ?? e.changedBy ?? 'System'} ·{' '}
                      {stamp.format(new Date(e.changedAt))}
                    </div>
                    {e.reasonCode ? (
                      <div className="mt-0.5 text-[11px] text-violet-700 dark:text-violet-300">
                        {rollbackReasonLabel(e.reasonCode)}
                        {e.reasonNote ? (
                          <span className="text-slate-500"> — {e.reasonNote}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>

              {cursor ? (
                <button
                  type="button"
                  onClick={() => void load(cursor)}
                  disabled={loading}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-[11px] hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:hover:bg-slate-800/40"
                >
                  {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : null}
                  Load older changes
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
