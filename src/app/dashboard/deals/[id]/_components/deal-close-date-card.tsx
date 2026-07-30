'use client';

import { Check, ChevronDown, Loader2, Pencil, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { patchDealAction } from '@/app/dashboard/deals/actions';
import { formatSlipDate, slipTooltip } from '@/lib/deals/slip';
import { cn } from '@/lib/utils';

/**
 * The Expected close card on the deal detail page. A specialised sibling of
 * `EditableDetailCard` rather than another instance of it, because a close-date
 * edit carries three things the generic card has no concept of:
 *
 *   1. the pushback summary ("Pushed 3× since 31 Aug"),
 *   2. an inline, skippable "why is this pushed back?" prompt shown ONLY when
 *      the new date is later than the current one, and
 *   3. the Date history timeline, fetched on expand.
 *
 * The counters it renders are trigger-maintained (`deals.push_count` et al,
 * migration 0058) — this component never computes or writes them; it only
 * passes the optional reason along with the date so the trigger can attach it
 * to the change it logs.
 */

type DateChange = {
  id: string;
  oldCloseDate: string | null;
  newCloseDate: string | null;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
  reason: string | null;
  isPush: boolean;
};

const timestampFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function DealCloseDateCard({
  dealId,
  expectedCloseDate,
  originalCloseDate,
  pushCount,
  totalSlipDays,
  stage,
  canEdit,
}: {
  dealId: string;
  expectedCloseDate: string | null;
  originalCloseDate: string | null;
  pushCount: number;
  totalSlipDays: number;
  stage: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  // 'idle' → 'editing' → ('reason' when the date moved later) → idle
  const [mode, setMode] = useState<'idle' | 'editing' | 'reason'>('idle');
  const [value, setValue] = useState(expectedCloseDate ?? '');
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const dateInputRef = useRef<HTMLInputElement>(null);
  const reasonInputRef = useRef<HTMLTextAreaElement>(null);

  // History is fetched on expand, not on page render — most visits never open
  // it, and the board/detail render budget shouldn't pay for it.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DateChange[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Re-seed from the server whenever a fresh render lands and we're idle.
  const [syncedValue, setSyncedValue] = useState(expectedCloseDate ?? '');
  if (syncedValue !== (expectedCloseDate ?? '') && mode === 'idle') {
    setSyncedValue(expectedCloseDate ?? '');
    setValue(expectedCloseDate ?? '');
  }

  useEffect(() => {
    if (mode === 'editing') dateInputRef.current?.focus();
    if (mode === 'reason') reasonInputRef.current?.focus();
  }, [mode]);

  // A Lead may not carry a close date at all, so there's nothing to edit until
  // the deal is qualified (same rule the server enforces).
  const editable = canEdit && stage !== 'lead';

  const cancel = useCallback(() => {
    setValue(expectedCloseDate ?? '');
    setReason('');
    setMode('idle');
  }, [expectedCloseDate]);

  const commit = useCallback(
    (withReason: string | null) => {
      const next = value === '' ? null : value;
      setMode('idle');
      setReason('');
      startTransition(async () => {
        const result = await patchDealAction({
          id: dealId,
          expectedCloseDate: next,
          ...(withReason ? { closeDateChangeReason: withReason } : {}),
        });
        if (!result.ok) {
          toast.error(result.message);
          setValue(expectedCloseDate ?? '');
          router.refresh();
          return;
        }
        // The counters and the log are written by the DB trigger, so the fresh
        // server render is the only thing that knows the new state.
        setHistory(null);
        router.refresh();
      });
    },
    [dealId, expectedCloseDate, router, value],
  );

  function save() {
    const next = value === '' ? null : value;
    if (next === (expectedCloseDate ?? null)) {
      setMode('idle');
      return;
    }
    // Only a forward move gets the "why?" prompt. Clearing the date, setting a
    // first one, or pulling it in are not pushbacks and shouldn't interrogate
    // the rep.
    const isPush = !!expectedCloseDate && !!next && next > expectedCloseDate;
    if (isPush) {
      setMode('reason');
      return;
    }
    commit(null);
  }

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/date-history`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { changes: DateChange[] };
      setHistory(data.changes);
    } catch {
      setHistoryError('Could not load the date history.');
    } finally {
      setHistoryLoading(false);
    }
  }, [dealId]);

  function toggleHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null && !historyLoading) void loadHistory();
  }

  const pushed = pushCount > 0;

  return (
    <div
      className={cn(
        'group relative rounded-lg border border-slate-200 bg-white p-3 transition',
        editable && mode === 'idle' && 'hover:border-slate-300',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
          Expected close
        </span>
        {editable ? (
          mode === 'editing' ? (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={save}
                aria-label="Save expected close date"
                className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={cancel}
                aria-label="Cancel editing expected close date"
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </span>
          ) : mode === 'idle' ? (
            <button
              type="button"
              onClick={() => setMode('editing')}
              aria-label="Edit expected close date"
              className="rounded p-0.5 text-slate-300 opacity-0 transition hover:bg-slate-100 hover:text-slate-600 focus:opacity-100 group-hover:opacity-100"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          ) : null
        ) : null}
      </div>

      {mode === 'editing' ? (
        <div
          className="mt-1.5"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
        >
          <input
            ref={dateInputRef}
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px]"
          />
        </div>
      ) : (
        <div
          className={cn(
            'mt-1 text-[15px] font-medium text-slate-900',
            pending && 'opacity-50',
          )}
        >
          {formatSlipDate(expectedCloseDate)}
        </div>
      )}

      {/* Skippable, non-blocking: the date is already typed, this only decides
          whether the manager gets the context along with the red flag. */}
      {mode === 'reason' ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-[11px] font-medium text-amber-800 dark:text-amber-200">
            Why is this pushed back?
          </p>
          <p className="mt-0.5 text-[10px] text-amber-700/80 dark:text-amber-200/70">
            {formatSlipDate(expectedCloseDate)} → {formatSlipDate(value || null)}.
            Optional — you can skip it.
          </p>
          <textarea
            ref={reasonInputRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="e.g. client procurement delay"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            className="mt-1.5 w-full rounded-md border border-amber-200 bg-white px-2 py-1 text-[12px] dark:border-amber-500/30 dark:bg-transparent"
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={cancel}
              className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => commit(null)}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={() => commit(reason.trim() ? reason.trim() : null)}
              className="rounded bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}

      {stage === 'lead' ? (
        <p className="mt-1 text-[11px] leading-tight text-slate-400">
          Set once the deal reaches Qualified
        </p>
      ) : null}

      {pushed ? (
        <p
          className="mt-1.5 text-[11px] font-medium leading-tight text-rose-600 dark:text-rose-400"
          title={slipTooltip({
            originalCloseDate,
            expectedCloseDate,
            pushCount,
            totalSlipDays,
          })}
        >
          Pushed {pushCount}× since {formatSlipDate(originalCloseDate)}
          {totalSlipDays > 0 ? ` · ${totalSlipDays} days slipped` : null}
        </p>
      ) : null}

      <button
        type="button"
        onClick={toggleHistory}
        aria-expanded={historyOpen}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            historyOpen && 'rotate-180',
          )}
          aria-hidden
        />
        Date history
      </button>

      {historyOpen ? (
        <div className="mt-1.5 border-t border-slate-100 pt-1.5">
          {historyLoading ? (
            <p className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Loading…
            </p>
          ) : historyError ? (
            <p className="text-[11px] text-rose-600">{historyError}</p>
          ) : history && history.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {history.map((h) => (
                <li key={h.id} className="text-[11px] leading-tight">
                  <div className="flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        'font-medium',
                        h.isPush ? 'text-rose-600' : 'text-slate-700',
                      )}
                    >
                      {formatSlipDate(h.oldCloseDate)} →{' '}
                      {formatSlipDate(h.newCloseDate)}
                    </span>
                    {h.isPush ? (
                      <span className="rounded-full bg-rose-100 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                        Pushed
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-slate-500">
                    {h.changedByName ?? (h.changedBy ? 'Teammate' : 'System')} ·{' '}
                    {timestampFormatter.format(new Date(h.changedAt))}
                  </div>
                  {h.reason ? (
                    <p className="mt-0.5 whitespace-pre-wrap text-slate-600">
                      “{h.reason}”
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[11px] text-slate-400">
              No close-date changes recorded yet.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
