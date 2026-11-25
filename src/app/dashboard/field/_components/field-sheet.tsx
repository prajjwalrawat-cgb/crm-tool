'use client';

import { X } from 'lucide-react';
import { useEffect, useId, type ReactNode } from 'react';

/**
 * Dialog shell for the field pages: a bottom sheet on phones, a centred card
 * on wider screens. Escape / backdrop close it unless `busy`.
 */
export function FieldSheet({
  title,
  description,
  onClose,
  busy,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 sm:items-start sm:px-4 sm:py-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:max-h-[84vh] sm:max-w-lg sm:rounded-xl dark:border-[#262626] dark:bg-[#0F0F0F]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-[#1F1F1F]">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
              {title}
            </h2>
            {description ? <p className="mt-0.5 text-[12.5px] text-slate-500 dark:text-[#A1A1AA]">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="-mr-1 rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-[#181818]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-xl sm:px-5 dark:border-[#1F1F1F] dark:bg-[#111111]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
