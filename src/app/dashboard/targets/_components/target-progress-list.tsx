import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import {
  marginCoverageNote,
  splitCoverageNote,
} from '@/lib/targets/fy-attribution';
import { deweightedNote, pendingApprovalNote } from '@/lib/targets/quota-credit';
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
  emphasis = false,
}: {
  label: string;
  achievedMinor: number;
  targetMinor: number;
  ctx: TenantCurrencyContext;
  /** The attainment the card is actually about — sized up, others sized down. */
  emphasis?: boolean;
}) {
  const p = pct(achievedMinor, targetMinor);
  const width = Math.min(100, Math.max(0, p));
  const met = targetMinor > 0 && achievedMinor >= targetMinor;
  const noTarget = targetMinor <= 0;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
        <span className="font-medium text-slate-600 dark:text-[#A1A1AA]">
          {label}
        </span>
        <span className="text-slate-500 dark:text-[#A1A1AA]">
          <span
            className={cn(
              emphasis && 'text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]',
            )}
          >
            {formatTenantCurrency(achievedMinor, ctx)}
          </span>
          {noTarget ? (
            <span className="text-slate-400"> · no target set</span>
          ) : (
            <>
              {' / '}
              {formatTenantCurrency(targetMinor, ctx)}
              <span
                className={cn(
                  'ml-1.5 font-semibold',
                  emphasis && 'text-[13px]',
                  met ? 'text-emerald-600' : 'text-slate-600 dark:text-[#FAFAFA]',
                )}
              >
                {p}%
              </span>
            </>
          )}
        </span>
      </div>
      <div
        className={cn(
          'w-full overflow-hidden rounded-full bg-slate-100 dark:bg-[#1F1F1F]',
          emphasis ? 'h-3' : 'h-2.5',
        )}
      >
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

/** A figure reported for context, with no target and therefore no bar. */
function Stat({
  label,
  valueMinor,
  ctx,
  hint,
}: {
  label: string;
  valueMinor: number;
  ctx: TenantCurrencyContext;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-slate-500 dark:text-[#A1A1AA]">
        {label}
        {hint ? (
          <span className="ml-1 text-slate-400 dark:text-[#71717A]">{hint}</span>
        ) : null}
      </span>
      <span className="font-medium tabular-nums text-slate-700 dark:text-[#D4D4D8]">
        {formatTenantCurrency(valueMinor, ctx)}
      </span>
    </div>
  );
}

export function TargetProgressList({
  rows,
  ctx,
  fiscalLabel,
}: {
  rows: TargetProgressRow[];
  ctx: TenantCurrencyContext;
  /** "2026" or "FY2026–27" — names the window the primary bar measures. */
  fiscalLabel: string;
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
      {rows.map((r) => {
        const deweightNote = deweightedNote(
          r.deweightedLossMinor,
          r.deweightedCount,
          (minor) => formatTenantCurrency(minor, ctx),
        );
        const pendingNote = pendingApprovalNote(
          r.pendingApprovalMinor,
          r.pendingApprovalCount,
          (minor) => formatTenantCurrency(minor, ctx),
        );
        const coverageNote = splitCoverageNote(r.splitlessCount, r.wonCount);
        const marginNote = marginCoverageNote(r.marginMissingCount, r.wonCount);
        return (
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
              {/* THE attainment figure: this fiscal year's slice of the
                  contracts won, against this fiscal year's target. Labelled
                  with the year rather than "Revenue" so it can't be read as
                  the total value sold — which is the line directly below. */}
              <Bar
                label={`${fiscalLabel} revenue achievement`}
                achievedMinor={r.fyRevenueMinor}
                targetMinor={r.revenueTargetMinor}
                ctx={ctx}
                emphasis
              />

              {/* Total value sold, reported in full and never reduced by the
                  attribution above — a multi-year win is still a win, it just
                  isn't all this year's revenue. */}
              <div className="space-y-1 border-t border-slate-100 pt-2.5 dark:border-[#1F1F1F]">
                <Stat
                  label="TCV won"
                  hint="total contract value"
                  valueMinor={r.tcvWonMinor}
                  ctx={ctx}
                />
                {r.futurePeriodMinor > 0 ? (
                  <Stat
                    label="Future-period TCV"
                    hint="lands in later years"
                    valueMinor={r.futurePeriodMinor}
                    ctx={ctx}
                  />
                ) : null}
                {/* Rare: a deal closed this year whose contract had already
                    started. Hidden entirely when it doesn't apply. */}
                {r.priorPeriodMinor > 0 ? (
                  <Stat
                    label="Prior-period TCV"
                    hint="belonged to earlier years"
                    valueMinor={r.priorPeriodMinor}
                    ctx={ctx}
                  />
                ) : null}
              </div>

              {/* Margin is measured on TCV won, not on the fiscal-year slice —
                  said in the label, because two bars stacked together will
                  otherwise be read as measuring the same window. */}
              <div className="border-t border-slate-100 pt-2.5 dark:border-[#1F1F1F]">
                <Bar
                  label="Margin on TCV won"
                  achievedMinor={r.marginAchievedMinor}
                  targetMinor={r.marginTargetMinor}
                  ctx={ctx}
                />
              </div>

              {/* Everything that makes a number on this card less than it
                  looks. Each is null unless it actually applies, so a clean
                  card stays clean:
                    · coverage — FY revenue resting on the single-year
                      assumption for deals with no breakdown
                    · margin   — the bar reading low because data is missing,
                      not because margin was given away
                    · deweight — R6/R7 pushback haircut
                    · pending  — won revenue behind the approval gate */}
              {coverageNote || marginNote || deweightNote || pendingNote ? (
                <div className="space-y-1 border-t border-slate-100 pt-2.5 dark:border-[#1F1F1F]">
                  {coverageNote ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {coverageNote}
                    </p>
                  ) : null}
                  {marginNote ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {marginNote}
                    </p>
                  ) : null}
                  {deweightNote ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {deweightNote}
                    </p>
                  ) : null}
                  {pendingNote ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      {pendingNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
