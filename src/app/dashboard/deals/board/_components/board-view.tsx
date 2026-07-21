'use client';

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

import type { MembershipRole } from '@/db/schema';
import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import type { CompanyOption } from '@/lib/companies/queries';
import type { DealFilters } from '@/lib/deals/filters';
import type { DealBoard } from '@/lib/deals/queries';
import { type DealStage, DEAL_STAGES } from '@/lib/deals/schema';
import { canManageDeals } from '@/lib/rbac';
import { deserializeDeal } from '@/lib/realtime/events';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { DealFilterBar } from '../../_components/deal-filter-bar';
import { FilterChips, type FilterChip } from '../../../_components/filter-chips';
import { updateDealStageAction } from '../../actions';
import { loadMoreStageDealsAction } from '../actions';
import { LostReasonModal } from '../../_components/lost-reason-modal';
import { type BoardCard, DealCard } from './deal-card';
import { BoardColumn } from './board-column';

type LocalBoard = Record<DealStage, BoardCard[]>;

/** Which stages still have un-loaded deals past what's on the board. */
function computeInitialMore(
  board: DealBoard,
  counts: Record<DealStage, number>,
): Record<DealStage, boolean> {
  const out = {} as Record<DealStage, boolean>;
  for (const s of DEAL_STAGES) out[s] = counts[s] > board[s].length;
  return out;
}

type Props = {
  initialBoard: DealBoard;
  /** Total deals per stage (after RLS); the board may render fewer if capped. */
  stageCounts: Record<DealStage, number>;
  currentRole: MembershipRole;
  tenantId: string;
  initialFilters: DealFilters;
  companyOptions: CompanyOption[];
  teammates: Teammate[];
  currentUserId: string;
};

function isStage(value: string): value is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(value);
}

function findStageOf(board: LocalBoard, dealId: string): DealStage | null {
  for (const stage of DEAL_STAGES) {
    if (board[stage].some((d) => d.id === dealId)) return stage;
  }
  return null;
}

function moveBetween(
  board: LocalBoard,
  dealId: string,
  fromStage: DealStage,
  toStage: DealStage,
): LocalBoard {
  if (fromStage === toStage) return board;
  const card = board[fromStage].find((d) => d.id === dealId);
  if (!card) return board;
  // Only the from/to arrays get new references; other columns keep their
  // identity so memoized BoardColumns short-circuit re-render.
  return {
    ...board,
    [fromStage]: board[fromStage].filter((d) => d.id !== dealId),
    [toStage]: [
      { ...card, stage: toStage, __pending: true },
      ...board[toStage],
    ],
  };
}

function clearPendingForCard(board: LocalBoard, dealId: string): LocalBoard {
  for (const stage of DEAL_STAGES) {
    const idx = board[stage].findIndex((d) => d.id === dealId);
    if (idx !== -1 && board[stage][idx].__pending) {
      const nextList = board[stage].slice();
      nextList[idx] = { ...nextList[idx], __pending: false };
      return { ...board, [stage]: nextList };
    }
  }
  return board;
}

/**
 * Apply an inbound (remote) deal event to the local board. Idempotent —
 * an event for a card already in its target stage with the same fields
 * produces an array reference change but no visible difference. Designed
 * to be safe under duplicate delivery.
 */
function reconcileCard(state: LocalBoard, next: BoardCard): LocalBoard {
  let currentStage: DealStage | null = null;
  for (const stage of DEAL_STAGES) {
    if (state[stage].some((c) => c.id === next.id)) {
      currentStage = stage;
      break;
    }
  }

  if (!currentStage) {
    // Card isn't on the board yet (created or restored elsewhere). Add to
    // its target column.
    return {
      ...state,
      [next.stage]: [next, ...state[next.stage]],
    };
  }

  if (currentStage === next.stage) {
    return {
      ...state,
      [currentStage]: state[currentStage].map((c) =>
        c.id === next.id ? next : c,
      ),
    };
  }

  // Cross-column move (remote drag, or stage_changed via update).
  return {
    ...state,
    [currentStage]: state[currentStage].filter((c) => c.id !== next.id),
    [next.stage]: [next, ...state[next.stage]],
  };
}

function removeCard(state: LocalBoard, dealId: string): LocalBoard {
  let touched = false;
  const next: LocalBoard = { ...state };
  for (const stage of DEAL_STAGES) {
    if (next[stage].some((c) => c.id === dealId)) {
      next[stage] = next[stage].filter((c) => c.id !== dealId);
      touched = true;
    }
  }
  return touched ? next : state;
}

export function BoardView({
  initialBoard,
  stageCounts,
  currentRole,
  tenantId,
  initialFilters,
  companyOptions,
  teammates,
  currentUserId,
}: Props) {
  const canMove = canManageDeals(currentRole);
  // Reuse the list view's chip builder shape so the active-filter
  // strip looks identical between board and list. Built inline (small
  // and frequently changing); not worth memoizing here.
  const filterChips: FilterChip[] = [];
  if (initialFilters.stages && initialFilters.stages.length > 0) {
    filterChips.push({
      id: 'stages',
      keys: ['stage', 'stages'],
      label: `Stage: ${initialFilters.stages.length} selected`,
    });
  }
  if (
    initialFilters.companyIds &&
    initialFilters.companyIds.length > 0
  ) {
    filterChips.push({
      id: 'companies',
      keys: ['companyId', 'companyIds'],
      label: `Company: ${initialFilters.companyIds.length} selected`,
    });
  }
  if (initialFilters.ownerIds && initialFilters.ownerIds.length > 0) {
    filterChips.push({
      id: 'owners',
      keys: ['owner'],
      label: `Owner: ${initialFilters.ownerIds.length} selected`,
    });
  }
  if (initialFilters.mine) {
    filterChips.push({ id: 'mine', keys: ['mine'], label: 'Mine' });
  }
  if (initialFilters.unassigned) {
    filterChips.push({
      id: 'unassigned',
      keys: ['unassigned'],
      label: 'Unassigned',
    });
  }
  // Don't render the seed `currentUserId` — unused here but kept in the
  // prop signature so callers stay symmetric with the list view.
  void currentUserId;
  // Stage filter on the board hides columns the user didn't select so
  // the layout collapses to just the relevant lanes — matches the
  // list view's "stage IN (...)" semantics visually.
  const visibleStages: readonly DealStage[] =
    initialFilters.stages && initialFilters.stages.length > 0
      ? DEAL_STAGES.filter((s) => initialFilters.stages!.includes(s))
      : DEAL_STAGES;

  const [board, setBoard] = useState<LocalBoard>(() => initialBoard);
  const [activeCard, setActiveCard] = useState<BoardCard | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-column infinite scroll. `moreByStage` says whether more rows exist
  // past what's loaded; `loadingStages` drives the per-column spinner. A ref
  // guards against firing overlapping fetches for the same column while one
  // is already in flight (the sentinel can re-trigger during layout).
  const [moreByStage, setMoreByStage] = useState<Record<DealStage, boolean>>(
    () => computeInitialMore(initialBoard, stageCounts),
  );
  const [loadingStages, setLoadingStages] = useState<Set<DealStage>>(
    () => new Set(),
  );
  const loadingStagesRef = useRef<Set<DealStage>>(new Set());
  // Always-current mirror of `board` so the load-more handler reads the
  // latest column (including previously appended pages) without stale
  // closures. Set during render is allowed.
  const boardRef = useRef<LocalBoard>(board);
  boardRef.current = board;
  // A drag onto the Lost column, held until the reason modal is confirmed.
  const [lostPrompt, setLostPrompt] = useState<{
    dealId: string;
    snapshot: LocalBoard;
    next: LocalBoard;
    dealName: string;
  } | null>(null);

  // Track the most recent server-acknowledged board so a *late* error from a
  // prior request rolls back to the right state, not an even older one.
  const lastKnownGoodRef = useRef<LocalBoard>(initialBoard);
  // Sequence guard: ignore stale rollbacks if the user has dragged again
  // since this drag was issued. Without this, a slow rollback for drag #1
  // can clobber the optimistic state of drag #2.
  const dragSeqRef = useRef(0);

  // Reset our local state whenever the server-provided board changes — i.e.
  // after `revalidatePath` settles, the parent page re-renders with fresh
  // data and we adopt it.
  const lastInitialRef = useRef(initialBoard);
  if (lastInitialRef.current !== initialBoard) {
    lastInitialRef.current = initialBoard;
    lastKnownGoodRef.current = initialBoard;
    // Set during render is allowed inside the same component tree.
    setBoard(initialBoard);
    // Fresh server board → recompute which columns have more to load and
    // drop any in-flight pager bookkeeping (the new board supersedes it).
    setMoreByStage(computeInitialMore(initialBoard, stageCounts));
    loadingStagesRef.current = new Set();
    setLoadingStages(new Set());
  }

  // Fetch and append the next page of deals for one stage column. Idempotent
  // per column while a request is in flight; dedups by id so a card can't
  // appear twice if a realtime event raced the fetch.
  const handleLoadMore = useCallback(
    (stage: DealStage) => {
      if (loadingStagesRef.current.has(stage)) return;
      const col = boardRef.current[stage];
      const last = col[col.length - 1];
      if (!last) return;

      loadingStagesRef.current.add(stage);
      setLoadingStages((s) => new Set(s).add(stage));
      const cursor = { updatedAt: last.updatedAt.toISOString(), id: last.id };

      startTransition(async () => {
        const res = await loadMoreStageDealsAction({
          stage,
          cursor,
          filters: initialFilters,
        });
        loadingStagesRef.current.delete(stage);
        setLoadingStages((s) => {
          const n = new Set(s);
          n.delete(stage);
          return n;
        });
        if (!res.ok) {
          // Stop offering "load more" on error so the sentinel doesn't spin.
          setMoreByStage((m) => ({ ...m, [stage]: false }));
          return;
        }
        const incoming: BoardCard[] = res.rows.map((r) => ({
          ...r,
          __pending: false,
        }));
        setBoard((b) => {
          const existing = new Set(b[stage].map((c) => c.id));
          const fresh = incoming.filter((c) => !existing.has(c.id));
          if (fresh.length === 0) return b;
          const nextCol = [...b[stage], ...fresh];
          lastKnownGoodRef.current = {
            ...lastKnownGoodRef.current,
            [stage]: nextCol,
          };
          return { ...b, [stage]: nextCol };
        });
        setMoreByStage((m) => ({ ...m, [stage]: res.hasMore }));
      });
    },
    [initialFilters, startTransition],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Larger activation distance + small delay so horizontal scroll
      // and quick clicks don't get hijacked into drag gestures. Matches
      // Linear/Notion ergonomics — a click is a click, a drag is a drag.
      activationConstraint: { distance: 8, delay: 80, tolerance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  /**
   * Realtime subscription. Inbound deal events from this tenant's channel
   * are reconciled into the local board. Idempotent reducers mean our own
   * actions' echoes (which arrive on this same connection) don't duplicate
   * — they no-op against the optimistic state we already hold.
   */
  const handleRealtime = useCallback(
    (event: import('@/lib/realtime/events').RealtimeEvent) => {
      switch (event.type) {
        case 'deal.created':
        case 'deal.updated':
        case 'deal.stage_changed':
        case 'deal.restored': {
          const card: BoardCard = {
            ...deserializeDeal(event.deal),
            __pending: false,
          };
          setBoard((s) => reconcileCard(s, card));
          lastKnownGoodRef.current = reconcileCard(
            lastKnownGoodRef.current,
            card,
          );
          break;
        }
        case 'deal.deleted': {
          setBoard((s) => removeCard(s, event.dealId));
          lastKnownGoodRef.current = removeCard(
            lastKnownGoodRef.current,
            event.dealId,
          );
          break;
        }
        default:
          // Ignore non-deal events on the board view.
          break;
      }
    },
    [],
  );

  useRealtimeEvents(tenantId, handleRealtime);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const id = String(event.active.id);
      const stage = findStageOf(board, id);
      if (!stage) return;
      const card = board[stage].find((d) => d.id === id) ?? null;
      setActiveCard(card);
    },
    [board],
  );

  // Fire the stage change + reconcile optimistic state. Shared by normal drags
  // and the Lost-reason modal (which passes a `reason`).
  const commitStage = useCallback(
    (
      dealId: string,
      toStage: DealStage,
      snapshot: LocalBoard,
      next: LocalBoard,
      reason?: string,
    ) => {
      const seq = ++dragSeqRef.current;
      setError(null);
      startTransition(async () => {
        const result = await updateDealStageAction({
          id: dealId,
          stage: toStage,
          reason,
        });
        // If the user has issued a newer drag in the meantime, ignore this
        // outcome — the newer drag's transition owns the state now.
        if (seq !== dragSeqRef.current) return;

        if (!result.ok) {
          setBoard(snapshot);
          lastKnownGoodRef.current = snapshot;
          setError(result.message);
          return;
        }

        // Success: clear the pending flag on the moved card. The full
        // server-side board will arrive on the next render via revalidatePath
        // and overwrite this local state.
        setBoard((curr) => clearPendingForCard(curr, dealId));
        lastKnownGoodRef.current = clearPendingForCard(next, dealId);
      });
    },
    [startTransition],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveCard(null);
      const { active, over } = event;
      if (!over) return;

      const dealId = String(active.id);
      const overId = String(over.id);

      const fromStage = findStageOf(board, dealId);
      if (!fromStage) return;

      // overId is either a column's stage (drop on empty area) or another
      // card's id (drop on a card).
      const toStage: DealStage | null = isStage(overId)
        ? overId
        : findStageOf(board, overId);
      if (!toStage) return;
      if (toStage === fromStage) return;

      // Snapshot for rollback BEFORE we mutate. Using lastKnownGoodRef ensures
      // we restore to the most recent server-confirmed state, not an in-flight
      // optimistic state from a sibling drag.
      const snapshot = lastKnownGoodRef.current;
      const next = moveBetween(board, dealId, fromStage, toStage);
      setBoard(next);
      setError(null);

      // Moving to Lost: show the card in place but hold the commit until a
      // reason is entered. Cancel rolls the card back.
      if (toStage === 'lost') {
        const dealName = next.lost.find((d) => d.id === dealId)?.name ?? 'this deal';
        setLostPrompt({ dealId, snapshot, next, dealName });
        return;
      }

      commitStage(dealId, toStage, snapshot, next);
    },
    [board, commitStage],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
  }, []);

  const columns = useMemo(
    () =>
      visibleStages.map((stage) => (
        <BoardColumn
          key={stage}
          stage={stage}
          cards={board[stage]}
          totalCount={stageCounts[stage]}
          canMove={canMove}
          hasMore={moreByStage[stage] ?? false}
          loadingMore={loadingStages.has(stage)}
          onLoadMore={handleLoadMore}
        />
      )),
    [
      board,
      canMove,
      stageCounts,
      visibleStages,
      moreByStage,
      loadingStages,
      handleLoadMore,
    ],
  );

  // A second horizontal scrollbar mirrored above the board, so you don't have
  // to scroll to the bottom to pan across columns. The top strip's inner spacer
  // matches the columns' scroll width; scrollLeft is kept in sync both ways.
  const topScrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);

  useEffect(() => {
    const el = columnsRef.current;
    if (!el) return;
    const update = () => setScrollWidth(el.scrollWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [columns]);

  const syncFromTop = useCallback(() => {
    if (columnsRef.current && topScrollRef.current) {
      columnsRef.current.scrollLeft = topScrollRef.current.scrollLeft;
    }
  }, []);
  const syncFromColumns = useCallback(() => {
    if (columnsRef.current && topScrollRef.current) {
      topScrollRef.current.scrollLeft = columnsRef.current.scrollLeft;
    }
  }, []);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <DealFilterBar
        initialFilters={initialFilters}
        companyOptions={companyOptions}
        teammates={teammates}
        basePath="/dashboard/deals/board"
      />

      <FilterChips chips={filterChips} />

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      {!canMove ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Read-only — your role can&apos;t move deals between stages.
        </p>
      ) : null}

      {/* Top scrollbar — mirrors the board's horizontal scroll so you can pan
          columns without scrolling to the bottom. Hidden when nothing overflows. */}
      <div
        ref={topScrollRef}
        onScroll={syncFromTop}
        className="overflow-x-auto overscroll-x-contain"
        aria-hidden
      >
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          ref={columnsRef}
          onScroll={syncFromColumns}
          className={cn(
            'flex flex-1 gap-4 overflow-x-auto overscroll-x-contain pb-4',
            // Subtle scrollbar styling on the horizontal axis.
            'snap-x snap-mandatory sm:snap-none',
          )}
        >
          {columns}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <DealCard deal={activeCard} draggable={false} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>

      {lostPrompt ? (
        <LostReasonModal
          dealName={lostPrompt.dealName}
          onCancel={() => {
            // Roll the card back out of Lost.
            setBoard(lostPrompt.snapshot);
            lastKnownGoodRef.current = lostPrompt.snapshot;
            setLostPrompt(null);
          }}
          onConfirm={(reason) => {
            commitStage(
              lostPrompt.dealId,
              'lost',
              lostPrompt.snapshot,
              lostPrompt.next,
              reason,
            );
            setLostPrompt(null);
          }}
        />
      ) : null}
    </div>
  );
}
