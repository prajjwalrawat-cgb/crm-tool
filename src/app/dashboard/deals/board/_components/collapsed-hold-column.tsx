'use client';

import { useDroppable } from '@dnd-kit/core';
import { ChevronRight, PauseCircle } from 'lucide-react';

import { formatCurrency } from '@/lib/deals/currency';
import { cn } from '@/lib/utils';

/**
 * Slim, collapsed Hold lane (Module 6). Shows count + total and expands on
 * click. Still a drop target (droppable id 'hold') so a card can be dragged
 * onto it to trigger the hold-reason modal.
 */
export function CollapsedHoldColumn({
  count,
  totalAmountMinor,
  currency,
  isDragActive,
  onExpand,
}: {
  count: number;
  totalAmountMinor: number;
  currency: string;
  isDragActive: boolean;
  onExpand: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'hold' });

  return (
    <section
      ref={setNodeRef}
      aria-label="Hold column (collapsed)"
      className={cn(
        'flex w-40 shrink-0 flex-col rounded-lg border bg-orange-50/60 transition-colors dark:bg-orange-500/5',
        isDragActive ? 'border-dashed border-orange-300' : 'border-orange-200 dark:border-orange-500/30',
        isOver && 'bg-orange-100/80 ring-2 ring-orange-400/60',
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        className="flex items-center gap-2 border-b border-orange-200/70 px-3 py-2 text-left dark:border-orange-500/20"
      >
        <PauseCircle className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
        <span className="text-xs font-medium text-orange-800 dark:text-orange-300">Hold</span>
        <span className="text-xs font-semibold tabular-nums text-orange-700 dark:text-orange-300">{count}</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 text-orange-500" />
      </button>
      <div className="flex flex-1 flex-col items-start gap-0.5 px-3 py-2">
        <span className="text-xs font-semibold tabular-nums text-orange-800 dark:text-orange-300">
          {formatCurrency(totalAmountMinor, currency)}
        </span>
        <span className="text-[10px] text-orange-600 dark:text-orange-400/80">
          parked · click to expand
        </span>
      </div>
    </section>
  );
}
