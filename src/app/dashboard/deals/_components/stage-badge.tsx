import { type DealStage, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

const STAGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  qualified: 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  proposal:
    'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300',
  negotiation:
    'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  won: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  lost: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};

export function StageBadge({ stage }: { stage: DealStage }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        STAGE_STYLES[stage],
      )}
    >
      {DEAL_STAGE_LABELS[stage]}
    </span>
  );
}
