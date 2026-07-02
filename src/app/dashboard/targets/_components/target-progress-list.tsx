import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import type { TargetProgressRow } from '@/lib/targets/queries';
import { cn } from '@/lib/utils';

function pct(achieved: number, target: number): number {
  if (target <= 0) return achieved > 0 ? 100 : 0;
  return Math.round((achieved / target) * 100);
}

function Bar({
  label,
  achievedMinor,
  targetMinor,
  ctx,
}: {
  label: string;
  achievedMinor: number;
  targetMinor: number;
  ctx: TenantCurrencyContext;
}) {
  const p = pct(achievedMinor, targetMinor);
  const width = Math.min(100, Math.max(0, p));
  const met = targetMinor > 0 && achievedMinor >= targetMinor;
  const noTarget = targetMinor <= 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="font-medium text-slate-600 dark:text-[#A1A1AA]">
          {label}
        </span>
        <span className="text-slate-500 dark:text-[#A1A1AA]">
          {formatTenantCurrency(achievedMinor, ctx)}
          {noTarget ? (
            <span className="text-slate-400"> · no target set</span>
          ) : (
            <>
              {' / '}
              {formatTenantCurrency(targetMinor, ctx)}
              <span
                className={cn(
                  'ml-1.5 font-semibold',
                  met ? 'text-emerald-600' : 'text-slate-600 dark:text-[#FAFAFA]',
                )}
              >
                {p}%
              </span>
            </>
          )}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-[#1F1F1F]">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            met ? 'bg-emerald-500' : 'bg-indigo-500',
          )}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

export function TargetProgressList({
  rows,
  ctx,
}: {
  rows: TargetProgressRow[];
  ctx: TenantCurrencyContext;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
        No sales team members with targets for this year yet.
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map((r) => (
        <div
          key={r.userId}
          className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]"
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[14px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
                {r.displayName}
              </div>
              {r.role ? (
                <div className="text-[11px] capitalize text-slate-400">
                  {r.role}
                </div>
              ) : null}
            </div>
            <div className="text-right text-[11px] text-slate-500 dark:text-[#A1A1AA]">
              {r.wonCount} won{r.wonCount === 1 ? '' : ' deals'}
            </div>
          </div>
          <div className="space-y-3">
            <Bar
              label="Revenue"
              achievedMinor={r.revenueAchievedMinor}
              targetMinor={r.revenueTargetMinor}
              ctx={ctx}
            />
            <Bar
              label="Margin"
              achievedMinor={r.marginAchievedMinor}
              targetMinor={r.marginTargetMinor}
              ctx={ctx}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
