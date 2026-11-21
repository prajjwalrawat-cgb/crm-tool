'use client';

import { useDraggable } from '@dnd-kit/core';
import { memo } from 'react';

import type { ProspectCard as Card } from '@/lib/prospects/rules';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

export type BoardCard = Card & { __pending?: boolean };

const DAY_MS = 86_400_000;

export function daysLeft(expires: Date | null, now = Date.now()): number | null {
  if (!expires) return null;
  return Math.max(0, Math.ceil((new Date(expires).getTime() - now) / DAY_MS));
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}

type Props = {
  card: BoardCard;
  teammates: Map<string, Teammate>;
  /** Viewers get no drag handle or checkbox. */
  interactive: boolean;
  selected?: boolean;
  overlay?: boolean;
  onSelectToggle?: (id: string) => void;
  onOpen?: (id: string) => void;
};

function ProspectCardImpl({ card, teammates, interactive, selected, overlay, onSelectToggle, onOpen }: Props) {
  const draggable = interactive && !overlay && !card.promotedDealId;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id,
    disabled: !draggable,
  });
  const claimer = card.claimedBy ? teammates.get(card.claimedBy) : null;
  const left = daysLeft(card.claimExpiresAt);
  const territory = [card.city, card.state].filter(Boolean).join(', ');

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(draggable ? { ...listeners, ...attributes } : {})}
      onClick={() => onOpen?.(card.id)}
      className={cn(
        'rounded-md border border-slate-200 bg-white p-2.5 text-left shadow-sm',
        draggable && 'cursor-grab active:cursor-grabbing',
        isDragging && 'opacity-40',
        card.__pending && 'opacity-70',
        selected && 'ring-2 ring-indigo-400',
        overlay && 'shadow-lg',
      )}
    >
      <div className="flex items-start gap-2">
        {interactive && !overlay ? (
          <input
            type="checkbox"
            aria-label={`Select ${card.companyName}`}
            checked={!!selected}
            onChange={() => onSelectToggle?.(card.id)}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-slate-900">{card.companyName}</p>
          {card.contactName ? <p className="truncate text-[12px] text-slate-500">{card.contactName}</p> : null}
        </div>
        {card.icpScore !== null ? (
          <span
            title="ICP score"
            className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-indigo-700"
          >
            {card.icpScore}
          </span>
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{card.sourceTag}</span>
        {card.productFitName ? (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
            {card.productFitName}
          </span>
        ) : null}
        {card.clusterTags.map((t) => (
          <span key={t} className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
            {t}
          </span>
        ))}
      </div>
      {territory ? <p className="mt-1 truncate text-[11px] text-slate-400">{territory}</p> : null}

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          {card.claimedBy ? (
            <>
              <span
                title={claimer?.displayName ?? 'Claimed'}
                className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-[9px] font-semibold text-slate-700"
              >
                {claimer?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={claimer.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  initials(claimer?.displayName ?? '?')
                )}
              </span>
              {left !== null ? <span>{left}d left</span> : null}
            </>
          ) : (
            <span className="text-slate-400">Unclaimed</span>
          )}
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          {card.votesKnowSomeone > 0 ? <span title="Know someone there">{card.votesKnowSomeone} know</span> : null}
          {card.votesPriority > 0 ? <span title="Priority votes">{card.votesPriority} prio</span> : null}
          {card.promotedDealId ? <span className="text-emerald-600">Promoted</span> : null}
        </span>
      </div>
    </div>
  );
}

export const ProspectCardView = memo(ProspectCardImpl);
