'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Loader2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';

import { formatCurrency } from '@/lib/deals/currency';
import {
  type DealStage,
  DEAL_STAGE_LABELS,
  DEAL_TYPE_LABELS,
  type DealType,
} from '@/lib/deals/schema';
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
  /** Summed amount (minor units) across ALL deals in the stage. */
  totalAmountMinor: number;
  /** Deals in this stage whose close date has been pushed at least once. */
  slippedCount: number;
  /** Their summed amount (minor units) — the column's raw value at risk. */
  slippedAmountMinor: number;
  /** Win probability (0–100) for this stage — weights the pipeline value. */
  probability: number;
  /** Workspace currency for the totals. */
  currency: string;
  canMove: boolean;
  /** A card is currently being dragged somewhere on the board. */
  isDragActive: boolean;
  /** More rows exist past what's loaded — render the scroll sentinel. */
  hasMore: boolean;
  /** A page fetch for this column is in flight. */
  loadingMore: boolean;
  /** Request the next page for this stage, passing the last card's cursor. */
  onLoadMore: (
    stage: DealStage,
    cursor: { updatedAt: string; id: string },
  ) => void;
  /**
   * Bulk-select controls for this column. Only the Qualified column gets
   * these today — the temporary "send it back to Lead" cleanup after the
   * Lead close-date rollout. Absent = no select affordance at all.
   */
  selection?: ColumnSelection;
};

export type ColumnSelection = {
  /** Select mode is on — cards show checkboxes and drag is suspended. */
  active: boolean;
  selectedIds: Set<string>;
  /** The bulk action is in flight. */
  pending: boolean;
  onStart: () => void;
  onCancel: () => void;
  onToggle: (dealId: string) => void;
  /** Select every loaded card in this column, or clear the selection. */
  onToggleAll: (ids: string[]) => void;
  onConfirm: () => void;
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
  totalAmountMinor,
  slippedCount,
  slippedAmountMinor,
  probability,
  currency,
  canMove,
  isDragActive,
  hasMore,
  loadingMore,
  onLoadMore,
  selection,
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
        if (!entries.some((e) => e.isIntersecting)) return;
        // Page from the last (oldest) loaded card in this column.
        const last = cards[cards.length - 1];
        if (!last) return;
        const updatedAt =
          last.updatedAt instanceof Date
            ? last.updatedAt.toISOString()
            : new Date(last.updatedAt).toISOString();
        onLoadMore(stage, { updatedAt, id: last.id });
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore, stage, cards]);

  // Sortable items are deal ids — passed as a stable string array so dnd-kit's
  // SortableContext doesn't reconcile every render.
  const items = useMemo(() => cards.map((c) => c.id), [cards]);

  // Disambiguate cards that share a name within this column. Duplicates get a
  // suffix from deal_type (e.g. "— Renewal"); when the type is absent or would
  // still collide, we fall back to a numeric index so the name+suffix is
  // always unique on screen.
  const suffixById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const out: Record<string, string> = {};
    const used = new Set<string>();
    for (const c of cards) {
      if ((counts.get(c.name) ?? 0) <= 1) continue;
      const base = c.dealType
        ? DEAL_TYPE_LABELS[c.dealType as DealType]
        : '';
      let suffix = base || '#1';
      let n = 1;
      while (used.has(`${c.name}|${suffix}`)) {
        n += 1;
        suffix = base ? `${base} ${n}` : `#${n}`;
      }
      used.add(`${c.name}|${suffix}`);
      out[c.id] = suffix;
    }
    return out;
  }, [cards]);

  // Raw total is the server-computed sum across ALL deals in the stage (not
  // just the loaded page). Weighted = raw × stage probability.
  const weightedMinor = Math.round((totalAmountMinor * probability) / 100);
  // Same weighting applied to the pushed cohort only, so the "at risk" figure
  // is comparable with the column's weighted total rather than its raw one.
  const slippedWeightedMinor = Math.round(
    (slippedAmountMinor * probability) / 100,
  );

  return (
    <section
      aria-label={`${DEAL_STAGE_LABELS[stage]} column`}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border bg-slate-50 transition-colors',
        // While a card is in flight, mark every column as a valid drop zone
        // with a dashed outline; the one under the pointer gets a subtle
        // background wash + a stronger ring.
        isDragActive ? 'border-dashed border-indigo-300' : 'border-slate-200',
        isOver && 'bg-indigo-50/70 ring-2 ring-indigo-400/60',
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
        {totalCount > 0 ? (
          <div className="flex min-w-0 flex-col items-end leading-tight">
            <span className="truncate text-xs font-semibold tabular-nums text-slate-700">
              {formatCurrency(totalAmountMinor, currency)}
            </span>
            <span
              className="truncate text-[10px] tabular-nums text-slate-400"
              title={`Weighted at ${probability}% stage probability`}
            >
              {formatCurrency(weightedMinor, currency)} weighted
            </span>
            {/* Pushback rollup — rendered only when this column actually has a
                slipping cohort, so healthy columns stay uncluttered. */}
            {slippedCount > 0 ? (
              <span
                className="truncate text-[10px] font-medium tabular-nums text-rose-600 dark:text-rose-400"
                title={`${slippedCount} ${
                  slippedCount === 1 ? 'deal' : 'deals'
                } in this stage have had their close date pushed at least once. ${formatCurrency(
                  slippedAmountMinor,
                  currency,
                )} raw, weighted at ${probability}% stage probability.`}
              >
                {formatCurrency(slippedWeightedMinor, currency)} at risk (
                {slippedCount} pushed)
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {selection ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-1.5 text-[11px]">
          {!selection.active ? (
            <button
              type="button"
              onClick={selection.onStart}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-600 hover:bg-slate-50"
            >
              Select
            </button>
          ) : (
            <>
              <span className="font-medium tabular-nums text-slate-600">
                {selection.selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={() => selection.onToggleAll(cards.map((c) => c.id))}
                disabled={selection.pending}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {selection.selectedIds.size === cards.length && cards.length > 0
                  ? 'Clear'
                  : `All (${cards.length})`}
              </button>
              <button
                type="button"
                onClick={selection.onConfirm}
                disabled={selection.pending || selection.selectedIds.size === 0}
                title="Moves the selected deals back to Lead and clears their expected close date"
                className="inline-flex items-center gap-1 rounded bg-indigo-600 px-2 py-0.5 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {selection.pending ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                ) : null}
                Move to Lead
              </button>
              <button
                type="button"
                onClick={selection.onCancel}
                disabled={selection.pending}
                className="rounded px-1.5 py-0.5 text-slate-500 hover:text-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          )}
          {selection.active ? (
            <p className="w-full text-[10px] leading-tight text-amber-700">
              Their expected close date will be cleared — a Lead can&apos;t
              hold one.
            </p>
          ) : null}
        </div>
      ) : null}

      <div
        ref={setNodeRef}
        className="flex flex-1 flex-col gap-2 p-2"
        // min-height keeps an empty column droppable.
        style={{ minHeight: '6rem' }}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <DealCard
              key={card.id}
              deal={card}
              // Drag is suspended while picking cards — a drag gesture and a
              // multi-select gesture on the same card fight each other.
              draggable={canMove && !selection?.active}
              suffix={suffixById[card.id] ?? null}
              selectable={selection?.active ?? false}
              selected={selection?.selectedIds.has(card.id) ?? false}
              onSelectToggle={selection?.onToggle}
            />
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
