import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DayView } from '@/lib/field/day';
import { cn } from '@/lib/utils';

function Tile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'risk' }) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-white px-4 py-3 dark:bg-[#0F0F0F]',
        tone === 'risk' ? 'border-amber-300 dark:border-amber-700/60' : 'border-slate-200 dark:border-[#262626]',
      )}
    >
      <dt className="text-[12px] font-medium text-slate-500 dark:text-[#A1A1AA]">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]">{value}</dd>
      {sub ? <dd className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">{sub}</dd> : null}
    </div>
  );
}

/**
 * Day totals across the whole scope (not narrowed by "Only at risk"): planned,
 * checked in, at risk, and the distinct-deal pipeline in play (tenant currency;
 * other-currency deals are counted, not converted).
 */
export function KpiStrip({ kpis, pipelineLabel }: { kpis: DayView['kpis']; pipelineLabel: string }) {
  const other = kpis.otherCurrencyDeals;
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile label="Meetings planned" value={kpis.planned} />
      <Tile label="Checked in" value={kpis.checkedIn} sub={kpis.planned > 0 ? `of ${kpis.planned}` : undefined} />
      <Tile
        label="At risk"
        tone={kpis.atRisk > 0 ? 'risk' : undefined}
        value={
          <span className="inline-flex items-center gap-1.5">
            {kpis.atRisk > 0 ? <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden /> : null}
            {kpis.atRisk}
          </span>
        }
      />
      <Tile
        label="Pipeline in play"
        value={pipelineLabel}
        sub={other > 0 ? `+${other} other-currency deal${other === 1 ? '' : 's'}` : undefined}
      />
    </dl>
  );
}
