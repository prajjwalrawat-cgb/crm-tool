'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart } from 'recharts';

/**
 * Recharts pieces for the manager reports. Loaded through next/dynamic
 * (see lazy.tsx) so the reports route doesn't pull recharts into the first
 * paint. Thin 2px lines, recessive grid, hover tooltip on every chart.
 */

const tooltipStyle = {
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--viz-grid)',
  background: 'var(--color-white, #fff)',
  color: 'inherit',
};

export function Sparkline({ data, label }: { data: Array<{ day: string; value: number | null }>; label: string }) {
  if (data.length < 2) return <div className="h-8" />;
  return (
    <div className="h-8 w-full" role="img" aria-label={`${label} by day`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <Tooltip
            cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }}
            contentStyle={tooltipStyle}
            labelFormatter={(d) => String(d)}
            formatter={(v) => [v === null ? '—' : String(v), label]}
          />
          <Line type="monotone" dataKey="value" stroke="var(--viz-1)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLine({ data, label, unit }: { data: Array<{ day: string; value: number | null }>; label: string; unit?: string }) {
  return (
    <div className="h-56 w-full" role="img" aria-label={`${label} trend`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--viz-axis)' }} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} minTickGap={24} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--viz-axis)' }} tickLine={false} axisLine={false} width={40} domain={[0, 'auto']} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => [v === null || v === undefined ? '—' : `${v}${unit ?? ''}`, label]} />
          <Line type="monotone" dataKey="value" stroke="var(--viz-1)" strokeWidth={2} dot={{ r: 3, fill: 'var(--viz-1)' }} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DailyBars({ data, label }: { data: Array<{ day: string; value: number }>; label: string }) {
  return (
    <div className="h-48 w-full" role="img" aria-label={`${label} by day`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barCategoryGap={2}>
          <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
          <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--viz-axis)' }} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--viz-axis)' }} tickLine={false} axisLine={false} width={32} />
          <Tooltip cursor={{ fill: 'var(--viz-grid)' }} contentStyle={tooltipStyle} formatter={(v) => [String(v), label]} />
          <Bar dataKey="value" fill="var(--viz-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
