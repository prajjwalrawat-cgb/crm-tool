'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Prompt shown before a deal is moved to the Lost stage. The reason is
 * required — you can Cancel to abort the move, but marking a deal lost always
 * captures why. Rendered via a portal so it floats above the list/board.
 */
export function LostReasonModal({
  dealName,
  pending,
  onCancel,
  onConfirm,
}: {
  dealName: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              Mark deal as Lost
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Why was <span className="font-medium">{dealName}</span> lost? This is
              saved on the deal.
            </p>
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

        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          placeholder="e.g. Lost on price to a competitor"
          className="mt-3 w-full resize-y rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[13px] focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]"
        />

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:hover:bg-slate-800/40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!trimmed || pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Mark as Lost
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
