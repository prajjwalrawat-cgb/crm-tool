import { type DealStage, DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import { cn } from '@/lib/utils';

const STAGE_STYLES: Record<DealStage, string> = {
  lead: 'bg-slate-100 text-slate-700',
  qualified: 'bg-blue-100 text-blue-700',
  proposal:
    'bg-indigo-100 text-indigo-700',
  negotiation:
    'bg-amber-100 text-amber-800',
  won: 'bg-emerald-100 text-emerald-700',
  lost: 'bg-red-100 text-red-700',
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
