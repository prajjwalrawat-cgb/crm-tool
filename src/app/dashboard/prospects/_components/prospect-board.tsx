'use client';

import {
  closestCorners,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';

import type { Comment, MembershipRole, Prospect, ProspectStage } from '@/db/schema';
import {
  groupKeyOf,
  PROSPECT_STAGES,
  type ProspectCard,
  type ProspectFilters,
} from '@/lib/prospects/rules';
import { can } from '@/lib/rbac';
import type { Teammate } from '@/lib/teammates/queries';

import { bulkMoveStageAction, bulkPromoteAction, bulkReleaseClaimsAction, moveProspectStageAction } from '../actions';
import { BoardToolbar } from './board-toolbar';
import { BulkBar, type BulkResult, type PromoteResults } from './bulk-bar';
import { NewProspectButton } from './new-prospect-button';
import { ProspectDrawer, type StageHistoryEntry } from './prospect-drawer';
import { type BoardCard, ProspectCardView } from './prospect-card';
import { ProspectColumn } from './prospect-column';

type Props = {
  cards: ProspectCard[];
  /** More prospects matched than the board loads. */
  truncated: boolean;
  filters: ProspectFilters;
  sourceTags: string[];
  teammates: Teammate[];
  /** Active offerings; used by the create dialog and drawer. */
  offerings: { id: string; name: string }[];
  role: MembershipRole;
  currentUserId: string;
  tenantId: string;
  /** Users the viewer may reassign claims to; null means everyone. */
  reassignScope: string[] | null;
  myVotes: { knowSomeone: boolean; priority: boolean };
  voteCounts: { knowSomeone: number; priority: number };
  openComments: Comment[];
  authorLookup: Record<string, string>;
  /** The prospect named by `?p=`, when it exists. */
  openProspect: Prospect | null;
  openHistory: StageHistoryEntry[];
  /** The open prospect's claim holder is within the viewer's team scope. */
  holderInScope: boolean;
};

type Lane = { key: string; label: string; cards: BoardCard[] };

const NONE_KEY = '__none';

/** Serialise filters (plus the open-card param) to a query string. */
function toQuery(f: ProspectFilters, p?: string | null): string {
  const sp = new URLSearchParams();
  if (f.mine) sp.set('mine', '1');
  if (f.unclaimed) sp.set('unclaimed', '1');
  if (f.source) sp.set('source', f.source);
  if (f.stage) sp.set('stage', f.stage);
  if (f.q) sp.set('q', f.q);
  if (f.showPromoted) sp.set('showPromoted', '1');
  if (f.groupBy) sp.set('groupBy', f.groupBy);
  if (p) sp.set('p', p);
  const s = sp.toString();
  return s ? `?${s}` : '?';
}

const collisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) return pointer;
  const rect = rectIntersection(args);
  if (rect.length > 0) return rect;
  return closestCorners(args);
};

export function ProspectBoard({
  cards: serverCards,
  truncated,
  filters,
  sourceTags,
  teammates,
  offerings,
  role,
  currentUserId,
  tenantId,
  reassignScope,
  myVotes,
  voteCounts,
  openComments,
  authorLookup,
  openProspect,
  openHistory,
  holderInScope,
}: Props) {
  const router = useRouter();
  const interactive = can(role, 'manageProspects');
  const canPark = can(role, 'bulkParkProspects');
  const canClaim = can(role, 'claimProspects');
  const canPromote = can(role, 'promoteProspects');

  const [cards, setCards] = useState<BoardCard[]>(serverCards);
  // Adopt the fresh server list after revalidatePath re-renders the page.
  const [lastServer, setLastServer] = useState(serverCards);
  if (lastServer !== serverCards) {
    setLastServer(serverCards);
    setCards(serverCards);
  }

  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [activeCard, setActiveCard] = useState<BoardCard | null>(null);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [promoteResults, setPromoteResults] = useState<PromoteResults | null>(null);
  // Prospect whose promote dialog should open with its drawer (from the bulk list).
  const [autoPromoteId, setAutoPromoteId] = useState<string | null>(null);
  // Guards a slow rollback from clobbering a newer drag.
  const dragSeqRef = useRef(0);

  const teammateMap = useMemo(() => new Map(teammates.map((t) => [t.id, t])), [teammates]);
  const names = useMemo(() => new Map(cards.map((c) => [c.id, c.companyName])), [cards]);

  const stages: readonly ProspectStage[] = filters.stage ? [filters.stage] : PROSPECT_STAGES;

  const lanes: Lane[] = useMemo(() => {
    if (!filters.groupBy) return [{ key: 'all', label: '', cards }];
    const by = new Map<string, Lane>();
    for (const c of cards) {
      const { key, label } = groupKeyOf(c, filters.groupBy);
      const lane = by.get(key) ?? { key, label, cards: [] };
      lane.cards.push(c);
      by.set(key, lane);
    }
    return [...by.values()].sort((a, b) => {
      if (a.key === NONE_KEY) return 1;
      if (b.key === NONE_KEY) return -1;
      return a.label.localeCompare(b.label);
    });
  }, [cards, filters.groupBy]);

  const writeFilters = useCallback(
    (next: ProspectFilters) => {
      router.replace(`/dashboard/prospects${toQuery(next)}`);
    },
    [router],
  );
  // Card click sets ?p=<id>; the page loads that prospect for the drawer.
  const openCard = useCallback(
    (id: string) => router.replace(`/dashboard/prospects${toQuery(filters, id)}`),
    [router, filters],
  );
  const closeCard = useCallback(
    () => router.replace(`/dashboard/prospects${toQuery(filters)}`),
    [router, filters],
  );
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sensors = useSensors(
    // Mouse: a drag starts only after 8px of movement, so a click always opens
    // the card. (With `delay` set, dnd-kit ignores `distance`: a click held
    // >80ms became a zero-move drag and its click event was swallowed.)
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // Touch: press-and-hold to drag, so a finger swipe still scrolls the board.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveCard(cards.find((c) => c.id === e.active.id) ?? null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveCard(null);
    const id = String(e.active.id);
    const to = e.over?.data.current?.stage as ProspectStage | undefined;
    const card = cards.find((c) => c.id === id);
    if (!card || !to || card.stage === to) return;

    const snapshot = cards;
    const seq = ++dragSeqRef.current;
    setError(null);
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, stage: to, __pending: true } : c)));
    startTransition(async () => {
      const result = await moveProspectStageAction(id, to);
      if (dragSeqRef.current !== seq) return;
      if (!result.ok) {
        setCards(snapshot);
        setError(result.message);
        return;
      }
      setCards((prev) => prev.map((c) => (c.id === id ? { ...c, __pending: false } : c)));
    });
  }

  function handleBulkMove(to: ProspectStage) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setBulkResult(null);
    startTransition(async () => {
      const result = await bulkMoveStageAction(ids, to);
      setBulkBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setBulkResult({ label: 'Moved', ...(result.data ?? { moved: 0, skipped: [] }) });
      setSelected(new Set());
    });
  }

  function handleBulkRelease() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setBulkResult(null);
    startTransition(async () => {
      const result = await bulkReleaseClaimsAction(ids);
      setBulkBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const d = result.data ?? { released: 0, skipped: [] };
      setBulkResult({ label: 'Done', moved: d.released, skipped: d.skipped });
      setSelected(new Set());
    });
  }

  function handleBulkPromote(ignoreWarnings: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setError(null);
    setBulkResult(null);
    setPromoteResults(null);
    startTransition(async () => {
      const result = await bulkPromoteAction(ids, ignoreWarnings);
      setBulkBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPromoteResults(result.data?.results ?? []);
      setSelected(new Set());
    });
  }

  return (
    <div className="flex flex-1 flex-col">
      <BoardToolbar
        filters={filters}
        sourceTags={sourceTags}
        onChange={writeFilters}
        actions={
          interactive ? (
            <div className="ml-auto flex items-center gap-2">
              <Link
                href="/dashboard/prospects/import"
                className="inline-flex items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-[#2A2A2A] dark:bg-[#111111] dark:text-[#E4E4E7] dark:hover:bg-[#181818]"
              >
                Quick dump
              </Link>
              <NewProspectButton offerings={offerings} sourceTags={sourceTags} />
            </div>
          ) : null
        }
      />

      {truncated ? (
        <p role="status" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Showing the 1,000 most recently active prospects. Use filters to narrow the board.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <DndContext
        // Stable id: otherwise dnd-kit numbers `aria-describedby` from a module
        // counter that differs between the server process and the browser,
        // and every card hydration-mismatches (same fix as the deals board).
        id="prospect-board"
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveCard(null)}
      >
        <div className="flex flex-col gap-6 overflow-x-auto pb-2">
          {lanes.map((lane) => (
            <div key={lane.key}>
              {filters.groupBy ? (
                <h2 className="mb-2 text-[13px] font-semibold text-slate-700">
                  {lane.label}{' '}
                  <span className="font-normal tabular-nums text-slate-400">{lane.cards.length}</span>
                </h2>
              ) : null}
              <div className="flex items-start gap-4">
                {stages.map((stage) => (
                  <ProspectColumn
                    key={stage}
                    lane={lane.key}
                    stage={stage}
                    cards={lane.cards.filter((c) => c.stage === stage)}
                    teammates={teammateMap}
                    interactive={interactive}
                    currentUserId={currentUserId}
                    selected={selected}
                    isDragActive={!!activeCard}
                    collapsed={stage === 'parked' && !parkedOpen && !filters.stage}
                    onToggleParked={() => setParkedOpen((v) => !v)}
                    onSelectToggle={toggleSelect}
                    onOpen={openCard}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeCard ? (
            <ProspectCardView
              card={activeCard}
              teammates={teammateMap}
              interactive={false}
              currentUserId={currentUserId}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {openProspect ? (
        <ProspectDrawer
          key={openProspect.id}
          autoPromote={autoPromoteId === openProspect.id}
          holderInScope={holderInScope}
          prospect={openProspect}
          history={openHistory}
          teammates={teammates}
          offerings={offerings}
          sourceTags={sourceTags}
          role={role}
          currentUserId={currentUserId}
          tenantId={tenantId}
          myVotes={myVotes}
          reassignScope={reassignScope}
          comments={openComments}
          authorLookup={authorLookup}
          voteCounts={voteCounts}
          onClose={closeCard}
        />
      ) : null}

      {interactive ? (
        <BulkBar
          count={selected.size}
          canPark={canPark}
          canRelease={canClaim}
          canPromote={canPromote}
          promoteResults={promoteResults}
          onPromote={handleBulkPromote}
          onOpenPromote={(id) => {
            setAutoPromoteId(id);
            openCard(id);
          }}
          onDismissPromote={() => setPromoteResults(null)}
          busy={bulkBusy}
          result={bulkResult}
          names={names}
          onMove={handleBulkMove}
          onRelease={handleBulkRelease}
          onClear={() => setSelected(new Set())}
          onDismissResult={() => setBulkResult(null)}
        />
      ) : null}
    </div>
  );
}
