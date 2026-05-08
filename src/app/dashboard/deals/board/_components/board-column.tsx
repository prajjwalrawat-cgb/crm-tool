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
  lead: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300',
  qualified:
    'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  proposal:
    'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
  negotiation:
    'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  won: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  lost: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};

type Props = {
  stage: DealStage;
  cards: BoardCard[];
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
        'flex w-72 shrink-0 flex-col rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40',
        isOver && 'ring-2 ring-indigo-500/40',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
            STAGE_HEADER_STYLES[stage],
          )}
        >
          {DEAL_STAGE_LABELS[stage]}
        </span>
        <span className="text-xs text-zinc-500">{cards.length}</span>
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
          <p className="rounded-md border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            Drop here
          </p>
        ) : null}
      </div>

      {cards.length > 0 ? (
        <footer className="border-t border-zinc-200 px-3 py-1.5 text-right text-xs text-zinc-500 dark:border-zinc-800">
          {formatCurrency(totalMinor, totalCurrency)}
        </footer>
      ) : null}
    </section>
  );
});
