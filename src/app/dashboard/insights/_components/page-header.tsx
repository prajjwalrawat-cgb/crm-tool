import { Suspense } from 'react';

import type { ReportPageContext } from '@/lib/reports/manager/page-context';

import { RangeControl } from './ui';

/** Title row + range control + scope note, shared by every reports page. */
export function PageHeader({
  ctx,
  title,
  description,
  actions,
  showRange = true,
  showCompare = false,
}: {
  ctx: ReportPageContext;
  title: string;
  description: string;
  actions?: React.ReactNode;
  showRange?: boolean;
  showCompare?: boolean;
}) {
  const scopeNote =
    ctx.scope.userIds === null
      ? ctx.scope.fallback
        ? 'Whole workspace — nobody reports to you yet (Settings › Reporting lines).'
        : 'Whole workspace.'
      : ctx.scope.userIds.length === 1
        ? 'Your own numbers.'
        : `You and the ${ctx.scope.userIds.length - 1} people who report to you.`;
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-[12px] text-slate-500">
          {description} {showRange && <span>{ctx.range.fromDay === ctx.range.toDay ? ctx.range.fromDay : `${ctx.range.fromDay} to ${ctx.range.toDay}`} ({ctx.range.tz}).</span>} {scopeNote}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {showRange && (
          <Suspense fallback={null}>
            <RangeControl range={ctx.range.preset} from={ctx.range.fromDay} to={ctx.range.toDay} compareTo={ctx.compareMode === 'none' ? 'previous' : ctx.compareMode} showCompare={showCompare} />
          </Suspense>
        )}
        {actions}
      </div>
    </div>
  );
}

/** Range query to forward to client fetches / exports. */
export function rangeQuery(ctx: ReportPageContext): Record<string, string> {
  const q: Record<string, string> = { range: ctx.range.preset };
  if (ctx.range.preset === 'custom') {
    q.from = ctx.range.fromDay;
    q.to = ctx.range.toDay;
  }
  if (ctx.compareMode !== 'previous') q.compareTo = ctx.compareMode;
  return q;
}
