'use client';

import { useDroppable } from '@dnd-kit/core';
import { ChevronRight, PauseCircle } from 'lucide-react';

import type { ProspectStage } from '@/db/schema';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { type BoardCard, ProspectCardView } from './prospect-card';

export const STAGE_LABELS: Record<ProspectStage, string> = {
  dump: 'Dump',
  researching: 'Researching',
  qualified: 'Qualified',
  ready: 'Ready',
  parked: 'Parked',
};

/** Droppable id is lane-scoped so swimlanes do not collide; data carries the stage. */
export const dropId = (lane: string, stage: ProspectStage) => `${lane}::${stage}`;

type Props = {
  lane: string;
  stage: ProspectStage;
  cards: BoardCard[];
  teammates: Map<string, Teammate>;
  interactive: boolean;
  currentUserId: string;
  selected: Set<string>;
  isDragActive: boolean;
  /** Parked renders as a slim bar until expanded. */
  collapsed?: boolean;
  onToggleParked?: () => void;
  onSelectToggle: (id: string) => void;
  onOpen: (id: string) => void;
};

export function ProspectColumn({
  lane,
  stage,
  cards,
  teammates,
  interactive,
  currentUserId,
  selected,
  isDragActive,
  collapsed,
  onToggleParked,
  onSelectToggle,
  onOpen,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId(lane, stage), data: { stage } });

  if (collapsed) {
    return (
      <section
        ref={setNodeRef}
        aria-label="Parked column (collapsed)"
        className={cn(
          'flex w-40 shrink-0 flex-col rounded-lg border bg-slate-50',
          isDragActive ? 'border-dashed border-slate-400' : 'border-slate-200',
          isOver && 'bg-slate-100 ring-2 ring-slate-400/60',
        )}
      >
        <button type="button" onClick={onToggleParked} className="flex items-center gap-2 px-3 py-2 text-left">
          <PauseCircle className="h-4 w-4 shrink-0 text-slate-500" />
          <span className="text-xs font-medium text-slate-700">Parked</span>
          <span className="text-xs font-semibold tabular-nums text-slate-600">{cards.length}</span>
          <ChevronRight className="ml-auto h-3.5 w-3.5 text-slate-400" />
        </button>
        <span className="px-3 pb-2 text-[10px] text-slate-400">click to expand</span>
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      aria-label={`${STAGE_LABELS[stage]} column`}
      className={cn(
        'flex w-72 shrink-0 flex-col rounded-lg border bg-slate-50',
        isDragActive ? 'border-dashed border-slate-300' : 'border-slate-200',
        isOver && 'bg-indigo-50/60 ring-2 ring-indigo-300/60',
      )}
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-medium text-slate-700">{STAGE_LABELS[stage]}</span>
        <span className="text-xs font-semibold tabular-nums text-slate-500">{cards.length}</span>
        {stage === 'parked' ? (
          <button
            type="button"
            onClick={onToggleParked}
            className="ml-auto text-[11px] text-slate-400 hover:text-slate-600"
          >
            Collapse
          </button>
        ) : null}
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 p-2">
        {cards.map((c) => (
          <ProspectCardView
            key={c.id}
            card={c}
            teammates={teammates}
            interactive={interactive}
            currentUserId={currentUserId}
            selected={selected.has(c.id)}
            onSelectToggle={onSelectToggle}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}
