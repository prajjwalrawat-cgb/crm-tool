import type { QuoteStatus } from '@/lib/quotes/types';
import { cn } from '@/lib/utils';

const TONE: Record<QuoteStatus, string> = {
  draft: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  sent: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  superseded: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-[#1A1A1A] dark:text-[#A1A1AA] dark:ring-[#333]',
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  superseded: 'Superseded',
};

/** Quote status pill: tone and text both carry the status. */
export function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', TONE[status])}>
      {QUOTE_STATUS_LABEL[status]}
    </span>
  );
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** "20 Nov 2026" (IST) for quote list rows. */
export function formatQuoteListDate(d: Date | string): string {
  return dateFmt.format(typeof d === 'string' ? new Date(d) : d);
}
