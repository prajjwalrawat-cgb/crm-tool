'use client';

import {
  closestCorners,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  rectIntersection,
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
import type { DealBoard, StageSlipRollup } from '@/lib/deals/queries';
import { type DealStage, DEAL_STAGES } from '@/lib/deals/schema';
import { canManageDeals } from '@/lib/rbac';
import { deserializeDeal } from '@/lib/realtime/events';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { DealFilterBar } from '../../_components/deal-filter-bar';
import { FilterChips, type FilterChip } from '../../../_components/filter-chips';
import { updateDealStageAction } from '../../actions';
import {
  loadMoreStageDealsAction,
  revertQualifiedDealsToLeadAction,
} from '../actions';
import { LostReasonModal } from '../../_components/lost-reason-modal';
import { HoldReasonModal } from '../../_components/hold-reason-modal';
import { ClearCloseDateModal } from '../../_components/clear-close-date-modal';
import { type BoardCard, DealCard } from './deal-card';
import { BoardColumn } from './board-column';
import { GateBlockPanel } from './gate-block-panel';
import { CollapsedHoldColumn } from './collapsed-hold-column';
import { SlippedOnlyToggle } from './slipped-only-toggle';
import type { GateFailure } from '@/lib/stage-gates/types';

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
  /** Per-stage summed amount (minor units) across all deals in the stage. */
  stageAmounts: Record<DealStage, number>;
  /** Per-stage pushed-deal rollup — the column's "value at risk" line. */
  stageSlipped: Record<DealStage, StageSlipRollup>;
  /** Per-stage win probability (0–100) for the weighted total. */
  stageProbabilities: Record<DealStage, number>;
  /** Workspace currency for the column totals. */
  boardCurrency: string;
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
  stageAmounts,
  stageSlipped,
  stageProbabilities,
  boardCurrency,
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
  if (initialFilters.slipped) {
    filterChips.push({
      id: 'slipped',
      keys: ['slipped'],
      label: 'Slipped only',
    });
  }
  // Don't render the seed `currentUserId` — unused here but kept in the
  // prop signature so callers stay symmetric with the list view.
  void currentUserId;
  // Stage filter on the board hides columns the user didn't select so
  // the layout collapses to just the relevant lanes — matches the
  // list view's "stage IN (...)" semantics visually.
  const visibleStages: readonly DealStage[] = (
    initialFilters.stages && initialFilters.stages.length > 0
      ? DEAL_STAGES.filter((s) => initialFilters.stages!.includes(s))
      : DEAL_STAGES
  ).filter(
    // Module 6: the Hold column is hidden entirely when empty. To put the first
    // deal on Hold, use "Put on hold" on the deal detail page.
    (s) =>
      s !== 'hold' ||
      (stageCounts.hold ?? 0) > 0 ||
      (initialFilters.stages?.includes('hold') ?? false),
  );

  const [board, setBoard] = useState<LocalBoard>(() => initialBoard);
  const [activeCard, setActiveCard] = useState<BoardCard | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // A drag rejected by a stage gate — drives the blocked-move slide-over.
  const [gateBlock, setGateBlock] = useState<{
    dealId: string;
    dealName: string;
    toStage: string;
    failures: GateFailure[];
  } | null>(null);

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
  // A drag onto the Lost column, held until the reason modal is confirmed.
  const [lostPrompt, setLostPrompt] = useState<{
    dealId: string;
    snapshot: LocalBoard;
    next: LocalBoard;
    dealName: string;
  } | null>(null);
  // A drag onto Hold, held until the reason + revisit date are entered.
  const [holdPrompt, setHoldPrompt] = useState<{
    dealId: string;
    snapshot: LocalBoard;
    next: LocalBoard;
    dealName: string;
  } | null>(null);
  // A drag back onto Lead by a dated deal, held until the user accepts that
  // the close date goes away.
  const [clearDatePrompt, setClearDatePrompt] = useState<{
    dealId: string;
    snapshot: LocalBoard;
    next: LocalBoard;
    dealName: string;
    closeDate: string | null;
  } | null>(null);
  // Hold column is collapsed to a slim bar by default when non-empty.
  const [holdExpanded, setHoldExpanded] = useState(false);

  // Whole-board pushed count, for the header toggle's badge. Server-computed
  // per stage, so this is a sum of counts, not a scan of the loaded cards.
  const totalSlippedOnBoard = DEAL_STAGES.reduce(
    (sum, s) => sum + (stageSlipped[s]?.count ?? 0),
    0,
  );

  // TEMPORARY (Lead close-date rollout): bulk-select in the Qualified column
  // to send deals the migration moved out of Lead back where they belong.
  // The revert clears their close date — see revertQualifiedDealsToLeadAction.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [reverting, setReverting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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

  // Fetch and append the next page of deals for one stage column. The column
  // supplies the cursor (its last loaded card), so this never reads board
  // state during render. Idempotent per column while a request is in flight;
  // dedups by id so a card can't appear twice if a realtime event raced.
  const handleLoadMore = useCallback(
    (stage: DealStage, cursor: { updatedAt: string; id: string }) => {
      if (loadingStagesRef.current.has(stage)) return;

      loadingStagesRef.current.add(stage);
      setLoadingStages((s) => new Set(s).add(stage));

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

  // Kanban collision detection. `closestCorners` alone can't target an EMPTY
  // column: a short empty lane (e.g. Hold with no deals) loses the corner-
  // distance contest to its tall, card-filled neighbours, so drops onto it
  // never resolve and the card snaps back. Prefer `pointerWithin` (is the
  // pointer inside this column?), which reliably hits empty lanes, then fall
  // back to rect intersection and finally closestCorners for keyboard drags
  // where there's no pointer. See dnd-kit multiple-containers guidance.
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) return pointerCollisions;
    const rectCollisions = rectIntersection(args);
    if (rectCollisions.length > 0) return rectCollisions;
    return closestCorners(args);
  }, []);

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
      hold?: { holdReason: string; holdRevisitOn: string; holdNote: string },
      clearCloseDate?: boolean,
    ) => {
      const seq = ++dragSeqRef.current;
      setError(null);
      startTransition(async () => {
        const result = await updateDealStageAction({
          id: dealId,
          stage: toStage,
          reason,
          holdReason: hold?.holdReason,
          holdRevisitOn: hold?.holdRevisitOn,
          holdNote: hold?.holdNote,
          clearCloseDate,
        });
        // If the user has issued a newer drag in the meantime, ignore this
        // outcome — the newer drag's transition owns the state now.
        if (seq !== dragSeqRef.current) return;

        if (!result.ok) {
          setBoard(snapshot);
          lastKnownGoodRef.current = snapshot;
          // Refused only because the deal is dated — the card we hold may be
          // stale (loaded before someone set a date), so honour the server's
          // signal and ask rather than erroring out.
          if (result.needsCloseDateClear) {
            setClearDatePrompt({
              dealId,
              snapshot,
              next,
              dealName:
                next[toStage].find((d) => d.id === dealId)?.name ?? 'this deal',
              closeDate:
                next[toStage].find((d) => d.id === dealId)?.expectedCloseDate ??
                null,
            });
            return;
          }
          // A stage gate rejected the move → show the checklist slide-over with
          // per-rule fixes rather than a bare toast.
          if (result.blocked && result.failures) {
            const dealName =
              next[toStage].find((d) => d.id === dealId)?.name ?? 'this deal';
            setGateBlock({
              dealId,
              dealName,
              toStage,
              failures: result.failures,
            });
          } else {
            setError(result.message);
          }
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

      // Moving to Hold: capture the reason + revisit date before committing.
      if (toStage === 'hold') {
        const dealName = next.hold.find((d) => d.id === dealId)?.name ?? 'this deal';
        setHoldPrompt({ dealId, snapshot, next, dealName });
        return;
      }

      // Dragging a dated deal back to Lead: it can keep the stage or the date,
      // not both. Confirm the trade before committing.
      const dragged = board[fromStage].find((d) => d.id === dealId);
      if (toStage === 'lead' && dragged?.expectedCloseDate) {
        setClearDatePrompt({
          dealId,
          snapshot,
          next,
          dealName: dragged.name,
          closeDate: dragged.expectedCloseDate,
        });
        return;
      }

      commitStage(dealId, toStage, snapshot, next);
    },
    [board, commitStage],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
  }, []);

  const toggleSelected = useCallback((dealId: string) => {
    setSelectedIds((curr) => {
      const next = new Set(curr);
      if (next.has(dealId)) next.delete(dealId);
      else next.add(dealId);
      return next;
    });
  }, []);

  const toggleAllSelected = useCallback((ids: string[]) => {
    setSelectedIds((curr) =>
      curr.size === ids.length ? new Set() : new Set(ids),
    );
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const confirmRevertToLead = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    // Optimistic: drop the cards into Lead with their date stripped, exactly
    // as the server will leave them.
    const snapshot = lastKnownGoodRef.current;
    setBoard((curr) => {
      const moving = curr.qualified.filter((c) => ids.includes(c.id));
      if (moving.length === 0) return curr;
      return {
        ...curr,
        qualified: curr.qualified.filter((c) => !ids.includes(c.id)),
        lead: [
          ...moving.map((c) => ({
            ...c,
            stage: 'lead' as DealStage,
            expectedCloseDate: null,
            __pending: true,
          })),
          ...curr.lead,
        ],
      };
    });
    setError(null);
    setNotice(null);
    setReverting(true);

    startTransition(async () => {
      const result = await revertQualifiedDealsToLeadAction({ dealIds: ids });
      setReverting(false);
      if (!result.ok) {
        setBoard(snapshot);
        lastKnownGoodRef.current = snapshot;
        setError(result.message);
        return;
      }
      // Anything the server refused stays where it is — the revalidated board
      // arriving next render is the source of truth, so just report it.
      const parts = [`${result.moved} moved back to Lead`];
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      if (result.blocked.length > 0) {
        parts.push(`blocked by a stage gate: ${result.blocked.join(', ')}`);
      }
      setNotice(`${parts.join(' · ')}. Close dates were cleared.`);
      exitSelectMode();
    });
  }, [selectedIds, exitSelectMode, startTransition]);

  const qualifiedSelection = useMemo(
    () =>
      canMove
        ? {
            active: selectMode,
            selectedIds,
            pending: reverting,
            onStart: () => setSelectMode(true),
            onCancel: exitSelectMode,
            onToggle: toggleSelected,
            onToggleAll: toggleAllSelected,
            onConfirm: confirmRevertToLead,
          }
        : undefined,
    [
      canMove,
      selectMode,
      selectedIds,
      reverting,
      exitSelectMode,
      toggleSelected,
      toggleAllSelected,
      confirmRevertToLead,
    ],
  );

  const columns = useMemo(
    () =>
      visibleStages.map((stage) =>
        stage === 'hold' && !holdExpanded ? (
          <CollapsedHoldColumn
            key="hold"
            count={stageCounts.hold ?? 0}
            totalAmountMinor={stageAmounts.hold ?? 0}
            currency={boardCurrency}
            isDragActive={activeCard !== null}
            onExpand={() => setHoldExpanded(true)}
          />
        ) : (
          <BoardColumn
            key={stage}
            stage={stage}
            cards={board[stage]}
            totalCount={stageCounts[stage]}
            totalAmountMinor={stageAmounts[stage] ?? 0}
            slippedCount={stageSlipped[stage]?.count ?? 0}
            slippedAmountMinor={stageSlipped[stage]?.amountMinor ?? 0}
            probability={stageProbabilities[stage] ?? 0}
            currency={boardCurrency}
            canMove={canMove}
            isDragActive={activeCard !== null}
            hasMore={moreByStage[stage] ?? false}
            loadingMore={loadingStages.has(stage)}
            onLoadMore={handleLoadMore}
            selection={stage === 'qualified' ? qualifiedSelection : undefined}
          />
        ),
      ),
    [
      board,
      canMove,
      activeCard,
      holdExpanded,
      qualifiedSelection,
      stageCounts,
      stageAmounts,
      stageSlipped,
      stageProbabilities,
      boardCurrency,
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

      <div className="flex flex-wrap items-center gap-2">
        <SlippedOnlyToggle
          active={!!initialFilters.slipped}
          totalSlipped={totalSlippedOnBoard}
        />
        <div className="min-w-0 flex-1">
          <FilterChips chips={filterChips} />
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {notice}
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
        // Stable id — without it dnd-kit derives `aria-describedby` from a
        // module-scoped counter that keeps climbing on the long-lived server
        // process while the browser bundle restarts at 0, so every card
        // hydration-mismatches on that attribute.
        id="deals-board"
        sensors={sensors}
        collisionDetection={collisionDetection}
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

      {holdPrompt ? (
        <HoldReasonModal
          dealName={holdPrompt.dealName}
          onCancel={() => {
            setBoard(holdPrompt.snapshot);
            lastKnownGoodRef.current = holdPrompt.snapshot;
            setHoldPrompt(null);
          }}
          onConfirm={(holdReason, holdRevisitOn, holdNote) => {
            commitStage(
              holdPrompt.dealId,
              'hold',
              holdPrompt.snapshot,
              holdPrompt.next,
              undefined,
              { holdReason, holdRevisitOn, holdNote },
            );
            setHoldExpanded(true);
            setHoldPrompt(null);
          }}
        />
      ) : null}

      {clearDatePrompt ? (
        <ClearCloseDateModal
          dealName={clearDatePrompt.dealName}
          closeDate={clearDatePrompt.closeDate}
          onCancel={() => {
            setBoard(clearDatePrompt.snapshot);
            lastKnownGoodRef.current = clearDatePrompt.snapshot;
            setClearDatePrompt(null);
          }}
          onConfirm={() => {
            // Strip the date from the optimistic card too, so it doesn't linger
            // on the Lead card until the revalidated board arrives.
            const next: LocalBoard = {
              ...clearDatePrompt.next,
              lead: clearDatePrompt.next.lead.map((c) =>
                c.id === clearDatePrompt.dealId
                  ? { ...c, expectedCloseDate: null }
                  : c,
              ),
            };
            setBoard(next);
            commitStage(
              clearDatePrompt.dealId,
              'lead',
              clearDatePrompt.snapshot,
              next,
              undefined,
              undefined,
              true,
            );
            setClearDatePrompt(null);
          }}
        />
      ) : null}

      {gateBlock ? (
        <GateBlockPanel
          dealId={gateBlock.dealId}
          dealName={gateBlock.dealName}
          toStage={gateBlock.toStage}
          failures={gateBlock.failures}
          onClose={() => setGateBlock(null)}
        />
      ) : null}
    </div>
  );
}
