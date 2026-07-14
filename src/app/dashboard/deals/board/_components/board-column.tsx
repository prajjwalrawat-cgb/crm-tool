'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { memo, useMemo } from 'react';

import { formatCurrency } from '@/lib/deals/currency';
import { type DealStage, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

import { type BoardCard, DealCard } from './deal-card';

const STAGE_HEADER_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-700',
  qualified:
    'bg-blue-100 text-blue-700',
  proposal:
    'bg-indigo-100 text-indigo-700',
  negotiation:
    'bg-amber-100 text-amber-800',
  hold: 'bg-orange-100 text-orange-700',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-red-100 text-red-700',
};

type Props = {
  stage: DealStage;
  cards: BoardCard[];
  /**
   * Total deals in this stage (after RLS). When > cards.length the
   * board has been capped and we surface "X / Y" + a "more in list" hint.
   */
  totalCount: number;
  canMove: boolean;
};

/**
 * Memoized: only rerenders when its `cards` array reference changes. The
 * BoardView's optimistic update only swaps the from/to columns, so the
 * other four BoardColumns short-circuit through React.memo's referential
 * equality check.
 */
export const BoardColumn = memo(function BoardColumn({
  stage,
  cards,
  totalCount,
  canMove,
}: Props) {
  // Use the column's stage as its drop id. When a card is dropped on the
  // column body (not on another card), `event.over.id` will be the stage.
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  // Sortable items are deal ids — passed as a stable string array so dnd-kit's
  // SortableContext doesn't reconcile every render.
  const items = useMemo(() => cards.map((c) => c.id), [cards]);

  const totalMinor = useMemo(
    () =>
      cards.reduce((sum, c) => sum + Number(c.amountMinor ?? 0), 0),
    [cards],
  );
  // All cards in a tenant *should* share a currency for sane totals; we
  // surface the first card's currency as the column total. Mixed-currency
  // tenants will see the first card's symbol with the summed minor units —
  // listed under tech debt below.
  const totalCurrency = cards[0]?.currency ?? 'USD';

  return (
    <section
      aria-label={`${DEAL_STAGE_LABELS[stage]} column`}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border border-slate-200 bg-slate-50',
        isOver && 'ring-2 ring-indigo-500/40',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="shrink-0 text-xs font-medium tabular-nums text-slate-500"
            title={
              totalCount > cards.length
                ? `Showing ${cards.length} of ${totalCount}`
                : undefined
            }
          >
            {totalCount > cards.length
              ? `${cards.length} / ${totalCount}`
              : cards.length}
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STAGE_HEADER_STYLES[stage],
            )}
          >
            {DEAL_STAGE_LABELS[stage]}
          </span>
        </div>
        {cards.length > 0 ? (
          <span className="truncate text-xs font-semibold tabular-nums text-slate-700">
            {formatCurrency(totalMinor, totalCurrency)}
          </span>
        ) : null}
      </header>

      <div
        ref={setNodeRef}
        className="flex flex-1 flex-col gap-2 p-2"
        // min-height keeps an empty column droppable.
        style={{ minHeight: '6rem' }}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <DealCard key={card.id} deal={card} draggable={canMove} />
          ))}
        </SortableContext>

        {cards.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-400">
            Drop here
          </p>
        ) : null}
      </div>
    </section>
  );
});
