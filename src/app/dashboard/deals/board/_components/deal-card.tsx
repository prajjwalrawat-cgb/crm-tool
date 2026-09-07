'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Flag, Loader2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';

import { formatCurrency } from '@/lib/deals/currency';
import type { DealRow } from '@/lib/deals/queries';
import {
  isDealOverdue,
  slipChipLabel,
  slipSeverity,
  slipTooltip,
} from '@/lib/deals/slip';
import {
  deweightTooltip,
  isDeweighted,
  rollbackChipLabel,
} from '@/lib/deals/stage-governance';
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

/** Chip colors for the "Pushed ×N" indicator, by slip severity. */
function slipChipClass(severity: 'watch' | 'severe'): string {
  return severity === 'severe'
    ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
    : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300';
}

/**
 * The de-weighted Pushed chip (R6): an outlined variant of the severe chip,
 * not a fourth color. Severity already earns rose at 3 pushes; the outline is
 * what says "and now it costs you something". A new hue here would read as a
 * different KIND of problem rather than a worse degree of the same one.
 */
const DEWEIGHTED_CHIP_CLASS =
  'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-500 ' +
  'dark:bg-rose-500/20 dark:text-rose-200 dark:ring-rose-400';

/**
 * The Rollback chip. Deliberately violet — a stage regression and a date slip
 * are different failures, and the spec is explicit that the two must not be
 * conflated. Sharing the amber/rose scale would imply they're the same signal
 * at different strengths.
 */
const ROLLBACK_CHIP_CLASS =
  'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300';

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

  const overdue = isDealOverdue(deal, today);
  // Timeline pushback (migration 0058). 'none' for a deal that has never been
  // pushed, so a healthy board looks exactly as it did before.
  const slip = slipSeverity(deal);
  // R6 — pushed past the de-weight threshold, so this deal is now worth half
  // toward quota. Escalates the chip's style and REPLACES its tooltip: the
  // consequence is the more important half of the message once it applies.
  const deweighted = isDeweighted(Number(deal.quotaWeight));
  const slipTitle =
    slip === 'none'
      ? undefined
      : deweighted
        ? `${slipTooltip(deal)} — ${deweightTooltip(deal.pushCount)}`
        : slipTooltip(deal);
  // Rollbacks are shown independently of pushes: a deal can be dragged
  // backward without its date ever moving, and vice versa.
  const rolledBack = (deal.rollbackCount ?? 0) > 0;

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      style={style}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      data-pending={deal.__pending ? '' : undefined}
      className={cn(
        'group relative rounded-md border bg-white p-3 text-sm shadow-sm transition',
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
      {/* Badly-slipped deals get a second spine, stacked just inside the
          health-band border rather than replacing it — the two say different
          things and a manager needs both. Absolutely positioned so the card's
          height and layout are untouched. */}
      {slip === 'severe' ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-rose-500 dark:bg-rose-400"
        />
      ) : null}

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
              title={`Health ${deal.healthScore}/100 — higher is better. The red triangle chip, when present, is the separate risk score where higher is worse.`}
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

      {/* Footer: amount, then the close date with its slip / overdue tags.
          Wraps to at most one extra line on a narrow column rather than
          growing every card. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
        <span className="font-mono">
          {formatCurrency(deal.amountMinor, deal.currency)}
        </span>
        <span className="flex flex-wrap items-center justify-end gap-1">
          {deal.expectedCloseDate ? (
            <span
              className={cn(
                'text-slate-500',
                overdue && 'font-medium text-red-600',
              )}
            >
              {dateFormatter.format(new Date(deal.expectedCloseDate))}
            </span>
          ) : null}
          {/* Overdue is its own failure mode: nobody has even rescheduled it.
              Independent of pushback, so both tags can show at once. */}
          {overdue ? (
            <span
              title="Past its close date and still open"
              className="inline-flex h-4 items-center rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"
            >
              Overdue
            </span>
          ) : null}
          {slip !== 'none' ? (
            <span
              title={slipTitle}
              className={cn(
                'inline-flex h-4 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                deweighted ? DEWEIGHTED_CHIP_CLASS : slipChipClass(slip),
              )}
            >
              {slip === 'severe' ? (
                <Flag className="h-2.5 w-2.5" aria-hidden />
              ) : null}
              {slipChipLabel(deal.pushCount)}
              {/* Says the cost out loud on the card itself. A haircut nobody
                  can see teaches nobody anything — which is the entire point
                  of R6 as a behavioural rule rather than just a math change. */}
              {deweighted ? <span className="font-bold">· 50%</span> : null}
            </span>
          ) : null}
          {/* Phase 1 risk, written nightly. Only Elevated and above earn a
              chip: a "low risk" badge on two thirds of the board would be
              decoration, and the point of a card chip is that it is rare
              enough to notice. */}
          {deal.riskScore != null && deal.riskBand !== 'low' ? (
            <span
              title={`Risk ${deal.riskScore}/100 — higher is worse, the opposite of the plain health number on this card. Rules-based, updated nightly.`}
              className={cn(
                'inline-flex h-4 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                deal.riskBand === 'high'
                  ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
              )}
            >
              <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
              {deal.riskScore}
            </span>
          ) : null}
          {rolledBack ? (
            <span
              title={`Moved backward through the funnel ${deal.rollbackCount}×. Open the deal's Audit tab for the reasons.`}
              className={cn(
                'inline-flex h-4 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                ROLLBACK_CHIP_CLASS,
              )}
            >
              <Undo2 className="h-2.5 w-2.5" aria-hidden />
              {rollbackChipLabel(deal.rollbackCount)}
            </span>
          ) : null}
        </span>
      </div>
    </article>
  );
});
