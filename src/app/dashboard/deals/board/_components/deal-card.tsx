'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';

import { formatCurrency } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import { cn } from '@/lib/utils';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export type BoardCard = DealRow & { __pending?: boolean };

type Props = {
  deal: BoardCard;
  /** Whether the active user can drag this card. */
  draggable: boolean;
  /** Render in dnd-kit's DragOverlay (no useSortable, no link). */
  overlay?: boolean;
};

function isOverdue(deal: BoardCard, now: Date): boolean {
  if (!deal.expectedCloseDate) return false;
  if (deal.stage === 'won' || deal.stage === 'lost') return false;
  // expectedCloseDate is 'YYYY-MM-DD' from Drizzle's date column.
  return new Date(deal.expectedCloseDate) < now;
}

export const DealCard = memo(function DealCard({
  deal,
  draggable,
  overlay = false,
}: Props) {
  const sortable = useSortable({
    id: deal.id,
    disabled: !draggable || overlay,
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    sortable;

  const style: React.CSSProperties = overlay
    ? {}
    : {
        transform: CSS.Transform.toString(transform),
        transition,
      };

  // Compute overdue against a fixed-day reference so SSR/CSR agree on the
  // first paint. Day-precision is enough for a CRM close date.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      style={style}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      data-pending={deal.__pending ? '' : undefined}
      className={cn(
        'group rounded-md border bg-white p-3 text-sm shadow-sm transition',
        'border-slate-200',
        deal.stage === 'won' &&
          'border-l-4 border-l-emerald-500',
        deal.stage === 'lost' &&
          'border-l-4 border-l-slate-400',
        deal.__pending && 'opacity-60',
        !overlay && draggable && 'cursor-grab active:cursor-grabbing',
        overlay && 'rotate-1 cursor-grabbing shadow-2xl',
        // Hide the original while dragging — dnd-kit moves the visual to
        // the DragOverlay. Without this you see two copies during drag.
        !overlay && isDragging && 'opacity-30',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        {overlay ? (
          <span className="font-medium leading-tight">{deal.name}</span>
        ) : (
          <Link
            href={`/dashboard/deals/${deal.id}`}
            // Stop the link from swallowing the drag pointerDown when the
            // card has activation distance — onClick still fires on a real
            // click (no movement); dnd-kit's PointerSensor activates only
            // after 4px of movement.
            onPointerDown={(e) => e.stopPropagation()}
            className="font-medium leading-tight hover:underline"
          >
            {deal.name}
          </Link>
        )}
        {deal.__pending ? (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-slate-400"
            aria-hidden
          />
        ) : null}
      </header>

      {(deal.companyName || deal.contactName || deal.contactEmail) ? (
        <p className="mt-1 truncate text-xs text-slate-600">
          {[deal.companyName, deal.contactName ?? deal.contactEmail]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}

      {deal.stage === 'won' && deal.approvalStatus === 'pending' ? (
        <span className="mt-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
          Pending approval
        </span>
      ) : null}

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="font-mono">
          {formatCurrency(deal.amountMinor, deal.currency)}
        </span>
        {deal.expectedCloseDate ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-slate-500',
              isOverdue(deal, today) &&
                'font-medium text-red-600',
            )}
          >
            {isOverdue(deal, today) ? (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            ) : null}
            {dateFormatter.format(new Date(deal.expectedCloseDate))}
          </span>
        ) : null}
      </div>
    </article>
  );
});
