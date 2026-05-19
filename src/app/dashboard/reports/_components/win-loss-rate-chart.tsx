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
import type { WinLossRateRow } from '@/lib/reports/queries/win-loss-rate';

const STAGE_COLORS: Record<'won' | 'lost', string> = {
  won: '#059669', // emerald-600
  lost: '#e11d48', // rose-600
};

/**
 * Two bars — Won / Lost — switchable by mode (count vs revenue).
 * Color carries the meaning (emerald=won, rose=lost); the axis label
 * shows the metric so the bars don't need legends.
 */
export function WinLossRateChart({
  rows,
  mode,
}: {
  rows: WinLossRateRow[];
  mode: 'count' | 'amount';
}) {
  const data = rows.map((r) => ({
    stage: r.stage === 'won' ? 'Won' : 'Lost',
    stageKey: r.stage,
    count: r.count,
    amount: Math.round(r.revenueMinor / 100),
  }));

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
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
              mode === 'amount' ? `$${formatNumber(v)}` : formatNumber(v)
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
                ? [`$${formatNumber(num)}`, 'Revenue']
                : [formatNumber(num), 'Deals'];
            }}
          />
          <Bar dataKey={mode} radius={[6, 6, 0, 0]} maxBarSize={80}>
            {data.map((d) => (
              <Cell key={d.stageKey} fill={STAGE_COLORS[d.stageKey]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
