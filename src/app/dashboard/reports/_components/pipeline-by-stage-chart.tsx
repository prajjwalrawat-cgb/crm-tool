'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import { formatNumber } from '@/lib/dates/format';
import type { PipelineByStageRow } from '@/lib/reports/queries/pipeline-by-stage';

/**
 * Bar chart for pipeline by stage. Two visual modes selectable by the
 * caller: `count` (number of deals per stage) vs `amount` (total deal
 * value per stage in major units).
 *
 * Recharts is intentionally kept thin — no custom tooltips with deep
 * branding, no animation overrides. Get a sensible v1 shipped; iterate
 * on visual polish after we see real tenant data.
 */
export function PipelineByStageChart({
  rows,
  mode,
  currency,
}: {
  rows: PipelineByStageRow[];
  mode: 'count' | 'amount';
  currency: TenantCurrencyContext;
}) {
  const data = rows.map((r) => ({
    stage: r.stageLabel,
    count: r.count,
    amount: Math.round(r.totalAmountMinor / 100),
  }));

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
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
            tickFormatter={(v: number) =>
              mode === 'amount'
                ? formatTenantCurrency(v * 100, currency)
                : formatNumber(v)
            }
          />
          <Tooltip
            cursor={{ fill: '#f1f5f9' }}
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              fontSize: 12,
            }}
            formatter={(value) => {
              const num = typeof value === 'number' ? value : Number(value ?? 0);
              return mode === 'amount'
                ? [formatTenantCurrency(num * 100, currency), 'Total value']
                : [formatNumber(num), 'Deal count'];
            }}
          />
          <Bar
            dataKey={mode}
            fill="#4f46e5"
            radius={[6, 6, 0, 0]}
            maxBarSize={56}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
