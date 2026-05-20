'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
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
import type {
  RevenueForecastExtras,
  RevenueForecastRow,
} from '@/lib/reports/queries/revenue-forecast';

import { MetricCard } from '../../_components/metric-card';

/**
 * Revenue Forecast — KPI band on top, area+line chart below, monthly
 * table at the bottom. The area shows the best-case envelope (every
 * deal closes); the line tracks the weighted-likely projection.
 *
 * Color encoding:
 *   indigo line     = likely (weighted)
 *   emerald area    = best case envelope
 *   amber/dashed    = worst case (high-confidence only) — drawn as
 *                     a thin line for visual contrast
 */
export function RevenueForecastSection({
  rows,
  extras,
  currency,
}: {
  rows: RevenueForecastRow[];
  extras: RevenueForecastExtras;
  currency: TenantCurrencyContext;
}) {
  const money = (minor: number) => formatTenantCurrency(minor, currency);
  if (rows.length === 0 || extras.totalDeals === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-[12.5px] text-slate-500">
        No open deals with an expected close date in this window.
      </div>
    );
  }

  const data = rows.map((r) => ({
    month: r.monthLabel,
    likely: Math.round(r.likelyMinor / 100),
    best: Math.round(r.bestCaseMinor / 100),
    worst: Math.round(r.worstCaseMinor / 100),
    deals: r.dealCount,
  }));

  const confidencePct = Math.round(extras.avgConfidence * 100);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          label="Likely"
          value={money(extras.totalLikelyMinor)}
          hint="Weighted forecast"
          tone="info"
        />
        <MetricCard
          label="Best case"
          value={money(extras.totalBestCaseMinor)}
          hint="If every open deal closes"
          tone="success"
        />
        <MetricCard
          label="Worst case"
          value={money(extras.totalWorstCaseMinor)}
          hint="Only deals ≥ 50% probability"
          tone="warning"
        />
        <MetricCard
          label="Confidence"
          value={`${confidencePct}%`}
          hint={`Across ${extras.totalDeals} open deals`}
          tone={confidencePct >= 60 ? 'success' : confidencePct >= 40 ? 'warning' : 'danger'}
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Forecast projection
        </div>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 8, right: 16, bottom: 16, left: 0 }}
            >
              <defs>
                <linearGradient id="bestArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="month"
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
                tickFormatter={(v: number) => money(v * 100)}
              />
              <Tooltip
                cursor={{ stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '3 3' }}
                contentStyle={{
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                  fontSize: 12,
                }}
                formatter={(value, name) => {
                  const num = typeof value === 'number' ? value : Number(value ?? 0);
                  return [money(num * 100), String(name)];
                }}
              />
              <Area
                type="monotone"
                dataKey="best"
                name="Best case"
                stroke="#10b981"
                fill="url(#bestArea)"
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="likely"
                name="Likely"
                stroke="#4f46e5"
                strokeWidth={2.5}
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="worst"
                name="Worst case"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Month</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Deals</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Likely</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Best case</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">Worst case</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.monthIso} className="transition-colors hover:bg-slate-50/70">
                <td className="px-3 py-2 font-medium">{row.monthLabel}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                  {row.dealCount}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900">
                  {money(row.likelyMinor)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-700">
                  {money(row.bestCaseMinor)}
                </td>
                <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-amber-700 md:table-cell">
                  {money(row.worstCaseMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
