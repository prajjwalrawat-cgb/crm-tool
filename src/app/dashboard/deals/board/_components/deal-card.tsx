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
  /**
   * Distinguishing suffix appended to the name when another visible card in
   * the same column shares this deal's name (e.g. "— Renewal"). Computed by
   * the column with full sibling context.
   */
  suffix?: string | null;
  /** Column is in bulk-select mode — render the checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onSelectToggle?: (dealId: string) => void;
};

function isOverdue(deal: BoardCard, now: Date): boolean {
  if (!deal.expectedCloseDate) return false;
  if (deal.stage === 'won' || deal.stage === 'lost') return false;
  // expectedCloseDate is 'YYYY-MM-DD' from Drizzle's date column.
  return new Date(deal.expectedCloseDate) < now;
}

/** Left-spine color derived from the Module 2 health band. */
function bandBorder(band: string | null): string {
  if (band === 'strong') return 'border-l-emerald-500';
  if (band === 'moderate') return 'border-l-amber-400';
  if (band === 'at_risk') return 'border-l-rose-500';
  // Not yet scored — neutral spine (no competing signal).
  return 'border-l-slate-200';
}

/** Chip colors for the numeric score, by band. */
function bandChip(band: string | null): string {
  if (band === 'strong')
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300';
  if (band === 'moderate')
    return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
  if (band === 'at_risk')
    return 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300';
  return 'bg-slate-100 text-slate-500 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]';
}

export const DealCard = memo(function DealCard({
  deal,
  draggable,
  overlay = false,
  suffix = null,
  selectable = false,
  selected = false,
  onSelectToggle,
}: Props) {
  const displayName = suffix ? `${deal.name} — ${suffix}` : deal.name;
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
        'border-slate-200 border-l-4',
        // Closed deals keep their stage-colored spine; open deals get the
        // Module 2 health-band color (green strong / amber moderate / red at
        // risk / neutral until first scored). One health system — see
        // lib/deals/scoring.
        deal.stage === 'won'
          ? 'border-l-emerald-500'
          : deal.stage === 'lost'
            ? 'border-l-slate-400'
            : bandBorder(deal.healthBand),
        deal.__pending && 'opacity-60',
        selected && 'ring-2 ring-indigo-400 ring-offset-1',
        !overlay && draggable && 'cursor-grab active:cursor-grabbing',
        // Lifted, slightly-rotated clone while dragging (dnd-kit DragOverlay).
        overlay && 'rotate-2 cursor-grabbing shadow-2xl ring-1 ring-indigo-300/60',
        // Hide the original while dragging — dnd-kit moves the visual to
        // the DragOverlay. Without this you see two copies during drag.
        !overlay && isDragging && 'opacity-30',
      )}
    >
      <header className="flex items-start justify-between gap-2">
        {selectable && !overlay ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelectToggle?.(deal.id)}
            // The card is a dnd-kit sortable; without this the checkbox's
            // pointerdown starts a drag instead of ticking the box.
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Select ${deal.name}`}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-indigo-600"
          />
        ) : null}
        {overlay ? (
          <span className="font-medium leading-tight">{displayName}</span>
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
            {displayName}
          </Link>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          {deal.stage === 'hold' ? (
            <span
              title="On hold — score frozen"
              className="inline-flex h-5 items-center rounded-full bg-orange-100 px-2 text-[10px] font-semibold uppercase tracking-wide text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"
            >
              On hold
            </span>
          ) : deal.stage !== 'won' &&
            deal.stage !== 'lost' &&
            deal.healthScore != null ? (
            <span
              title={`Health score: ${deal.healthScore}/100`}
              className={cn(
                'inline-flex h-5 min-w-7 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
                bandChip(deal.healthBand),
              )}
            >
              {deal.healthScore}
            </span>
          ) : null}
          {deal.__pending ? (
            <Loader2
              className="h-3 w-3 animate-spin text-slate-400"
              aria-hidden
            />
          ) : null}
        </span>
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
