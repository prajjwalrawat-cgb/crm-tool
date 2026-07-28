'use client';

import { CalendarOff, Loader2, X } from 'lucide-react';
import { createPortal } from 'react-dom';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/**
 * Confirmation shown before a dated deal moves back to Lead. A Lead can't hold
 * an expected close date, so the move trades the date away — this is where the
 * user agrees to that, instead of the move simply being refused.
 * Rendered via a portal so it floats above the list/board.
 */
export function ClearCloseDateModal({
  dealName,
  closeDate,
  pending,
  onCancel,
  onConfirm,
}: {
  dealName: string;
  /** 'YYYY-MM-DD' from the deals table, or null when we don't have it to hand. */
  closeDate: string | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move deal back to Lead"
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 rounded-full bg-amber-100 p-1.5 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <CalendarOff className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                Move back to Lead?
              </h2>
              <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                <span className="font-medium">{dealName}</span> has an expected
                close date
                {closeDate ? (
                  <>
                    {' of '}
                    <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
                      {dateFormatter.format(new Date(closeDate))}
                    </span>
                  </>
                ) : null}
                . A deal in Lead can&apos;t hold one, so moving it back{' '}
                <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
                  clears the date
                </span>
                . You&apos;ll re-enter it when the deal is qualified again.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800/60"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:hover:bg-slate-800/40"
          >
            Keep as is
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            autoFocus
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Move to Lead &amp; clear date
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
