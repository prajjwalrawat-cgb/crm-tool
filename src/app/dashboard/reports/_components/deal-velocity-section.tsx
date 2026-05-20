'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatNumber } from '@/lib/dates/format';
import { DEAL_STAGE_LABELS } from '@/lib/deals/schema';
import type {
  DealVelocityExtras,
  DealVelocityRow,
} from '@/lib/reports/queries/deal-velocity';
import { cn } from '@/lib/utils';

import { MetricCard } from '../../_components/metric-card';

/**
 * Deal Velocity — three views composed:
 *   1. KPI band   — avg time to close, fastest/slowest stage, stalled %
 *   2. Stage bars — horizontal-feel chart of avg days per stage,
 *                   tinted by relative slowness (bottleneck = rose)
 *   3. Table      — stage / sample / avg / median / max in numbers
 *
 * Color encoding on the bars:
 *   indigo   default
 *   rose     stages whose avg > 1.5× the median across stages → flagged as bottlenecks
 *   slate    stages with too few samples (<3) to read into
 */
export function DealVelocitySection({
  rows,
  extras,
}: {
  rows: DealVelocityRow[];
  extras: DealVelocityExtras;
}) {
  const populated = rows.filter((r) => r.sampleSize > 0);
  if (populated.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-[12.5px] text-slate-500">
        No stage transitions in this window. Move at least one deal between
        stages to populate this report.
      </div>
    );
  }

  // Color rule: a stage is a bottleneck if its avg is materially higher
  // than the median across all stages.
  const medianAvg = median(populated.map((r) => r.avgDays));
  function barColor(r: DealVelocityRow): string {
    if (r.sampleSize < 3) return '#cbd5e1'; // slate-300 — low confidence
    if (r.avgDays > medianAvg * 1.5) return '#e11d48'; // rose-600 — bottleneck
    if (r.stage === extras.fastestStage) return '#059669'; // emerald-600 — fastest
    return '#4f46e5'; // indigo-600 — default
  }

  const chartData = rows.map((r) => ({
    stage: r.stageLabel,
    stageKey: r.stage,
    avgDays: r.avgDays,
    sample: r.sampleSize,
    color: barColor(r),
  }));

  const stalledPct = Math.round(extras.stalledRate * 100);
  const bottleneckLabel =
    extras.bottleneckStage !== null
      ? DEAL_STAGE_LABELS[extras.bottleneckStage]
      : '—';
  const fastestLabel =
    extras.fastestStage !== null
      ? DEAL_STAGE_LABELS[extras.fastestStage]
      : '—';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          label="Avg to close"
          value={`${extras.avgDaysToClose}d`}
          hint={`Across ${extras.dealsWithHistory} closed deals`}
          tone={extras.avgDaysToClose <= 30 ? 'success' : extras.avgDaysToClose <= 60 ? 'warning' : 'danger'}
        />
        <MetricCard
          label="Fastest stage"
          value={fastestLabel}
          hint={
            extras.fastestStage !== null
              ? `${rows.find((r) => r.stage === extras.fastestStage)?.avgDays}d avg`
              : 'Need more data'
          }
          tone="info"
        />
        <MetricCard
          label="Bottleneck"
          value={bottleneckLabel}
          hint={
            extras.bottleneckStage !== null
              ? `${rows.find((r) => r.stage === extras.bottleneckStage)?.avgDays}d avg`
              : 'No clear bottleneck'
          }
          tone={extras.bottleneckStage !== null ? 'danger' : 'neutral'}
        />
        <MetricCard
          label="Stalled"
          value={`${stalledPct}%`}
          hint={`${extras.stalledCount} active deals`}
          tone={stalledPct < 10 ? 'success' : stalledPct < 25 ? 'warning' : 'danger'}
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Average days per stage
        </div>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 16, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="stage"
                stroke="#64748b"
                tickLine={false}
                axisLine={{ stroke: '#cbd5e1' }}
                fontSize={11}
              />
              <YAxis
                stroke="#64748b"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={(v: number) => `${v}d`}
              />
              <Tooltip
                cursor={{ fill: '#f1f5f9' }}
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                }}
                formatter={(value, _name, payload) => {
                  const num = typeof value === 'number' ? value : Number(value ?? 0);
                  const item = payload?.payload as { sample?: number } | undefined;
                  return [
                    `${num}d (n=${item?.sample ?? 0})`,
                    'Avg duration',
                  ];
                }}
              />
              <Bar dataKey="avgDays" radius={[6, 6, 0, 0]} maxBarSize={64}>
                {chartData.map((d) => (
                  <Cell key={d.stageKey} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Stage</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Sample</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Avg</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">Median</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">Max</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                key={row.stage}
                className={cn(
                  'transition-colors hover:bg-slate-50/70',
                  row.sampleSize === 0 && 'text-slate-400',
                )}
              >
                <td className="px-3 py-2 font-medium">
                  {row.stageLabel}
                  {row.stage === extras.bottleneckStage ? (
                    <span className="ml-2 rounded-full bg-rose-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200">
                      Bottleneck
                    </span>
                  ) : row.stage === extras.fastestStage ? (
                    <span className="ml-2 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
                      Fastest
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">
                  {formatNumber(row.sampleSize)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900">
                  {row.avgDays}d
                </td>
                <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-700 md:table-cell">
                  {row.medianDays}d
                </td>
                <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-500 lg:table-cell">
                  {row.maxDays}d
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
