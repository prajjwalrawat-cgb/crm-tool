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
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';

import type { MembershipRole } from '@/db/schema';
import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import type { DealBoard } from '@/lib/deals/queries';
import { type DealStage, DEAL_STAGES } from '@/lib/deals/schema';
import { canManageDeals } from '@/lib/rbac';
import { deserializeDeal } from '@/lib/realtime/events';
import { cn } from '@/lib/utils';

import { updateDealStageAction } from '../../actions';
import { type BoardCard, DealCard } from './deal-card';
import { BoardColumn } from './board-column';

type LocalBoard = Record<DealStage, BoardCard[]>;

type Props = {
  initialBoard: DealBoard;
  currentRole: MembershipRole;
  tenantId: string;
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

export function BoardView({ initialBoard, currentRole, tenantId }: Props) {
  const canMove = canManageDeals(currentRole);

  const [board, setBoard] = useState<LocalBoard>(() => initialBoard);
  const [activeCard, setActiveCard] = useState<BoardCard | null>(null);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Don't activate drag on a click — needed so the card name <Link>
      // remains clickable.
      activationConstraint: { distance: 4 },
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

      const seq = ++dragSeqRef.current;
      setError(null);

      startTransition(async () => {
        const result = await updateDealStageAction({ id: dealId, stage: toStage });
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
    [board],
  );

  const handleDragCancel = useCallback(() => {
    setActiveCard(null);
  }, []);

  const columns = useMemo(
    () =>
      DEAL_STAGES.map((stage) => (
        <BoardColumn
          key={stage}
          stage={stage}
          cards={board[stage]}
          canMove={canMove}
        />
      )),
    [board, canMove],
  );

  return (
    <div className="flex flex-1 flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {!canMove ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          Read-only — your role can&apos;t move deals between stages.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          className={cn(
            'flex flex-1 gap-4 overflow-x-auto pb-4',
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
    </div>
  );
}
