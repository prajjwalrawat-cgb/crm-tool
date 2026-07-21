'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Loader2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';

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
  /** Total deals in this stage (after RLS) — the true column count. */
  totalCount: number;
  canMove: boolean;
  /** More rows exist past what's loaded — render the scroll sentinel. */
  hasMore: boolean;
  /** A page fetch for this column is in flight. */
  loadingMore: boolean;
  /** Request the next page for this stage. */
  onLoadMore: (stage: DealStage) => void;
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
  hasMore,
  loadingMore,
  onLoadMore,
}: Props) {
  // Use the column's stage as its drop id. When a card is dropped on the
  // column body (not on another card), `event.over.id` will be the stage.
  const { setNodeRef, isOver } = useDroppable({ id: stage });

  // Infinite scroll: observe a sentinel at the bottom of the column and pull
  // the next page as it nears the viewport. The parent's ref-guard makes a
  // repeat trigger while a fetch is in flight a no-op, so we can observe
  // freely. rootMargin pre-fetches slightly before the sentinel is on screen.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore(stage);
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, stage, cards.length]);

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
                ? `${cards.length} of ${totalCount} loaded — scroll to load more`
                : `${totalCount} in stage`
            }
          >
            {totalCount}
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

        {/* Infinite-scroll sentinel + loading affordance. Only present while
            more rows remain, so a fully-loaded column shows nothing. */}
        {hasMore ? (
          <div
            ref={sentinelRef}
            className="flex items-center justify-center py-2 text-[11px] text-slate-400"
          >
            {loadingMore ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Loading more…
              </span>
            ) : (
              <span>Scroll to load more</span>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
});
