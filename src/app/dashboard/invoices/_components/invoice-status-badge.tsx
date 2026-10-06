import type { InvoiceStatus } from '@/lib/collections/diagnostic';
import { cn } from '@/lib/utils';

/** Paid / Partly paid / Unpaid, with Overdue taking precedence while money is owed. */
export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const label = status.state === 'paid' ? 'Paid' : status.overdue ? 'Overdue' : status.state === 'partial' ? 'Partly paid' : 'Unpaid';
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[11px] font-medium',
        status.state === 'paid' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
        status.state !== 'paid' && status.overdue && 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
        status.state === 'partial' && !status.overdue && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
        status.state === 'unpaid' && !status.overdue && 'bg-slate-100 text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]',
      )}
    >
      {label}
    </span>
  );
}
