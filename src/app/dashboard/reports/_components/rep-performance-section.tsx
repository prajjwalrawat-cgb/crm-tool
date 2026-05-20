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
import type { RepPerformanceRow } from '@/lib/reports/queries/rep-performance';
import { cn } from '@/lib/utils';

/**
 * Two-part visualization: a horizontal-style bar chart (revenue by rep,
 * top 10) above a full leaderboard table with every metric.
 *
 * We use a vertical-axis BarChart and rotate visually via min-width
 * tricks — Recharts' actual horizontal layout has rendering quirks
 * with long labels. Top 10 keeps the chart readable.
 */
export function RepPerformanceSection({
  rows,
  currency,
}: {
  rows: RepPerformanceRow[];
  currency: TenantCurrencyContext;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center text-[12px] text-slate-500">
        No activity in this window.
      </div>
    );
  }

  const top10 = rows.slice(0, 10);
  const chartData = top10.map((r) => ({
    name: shortName(r.ownerDisplayName),
    fullName: r.ownerDisplayName,
    revenue: Math.round(r.revenueMinor / 100),
  }));

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Revenue by rep (top 10)
        </div>
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 24, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="name"
                stroke="#64748b"
                tickLine={false}
                axisLine={{ stroke: '#cbd5e1' }}
                fontSize={11}
                angle={chartData.length > 6 ? -15 : 0}
                textAnchor={chartData.length > 6 ? 'end' : 'middle'}
              />
              <YAxis
                stroke="#64748b"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={(v: number) => formatTenantCurrency(v * 100, currency)}
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
                  return [formatTenantCurrency(num * 100, currency), 'Revenue'];
                }}
                labelFormatter={(_v, payload) => {
                  const item = payload?.[0]?.payload as
                    | { fullName?: string }
                    | undefined;
                  return item?.fullName ?? '';
                }}
              />
              <Bar dataKey="revenue" fill="#4f46e5" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-100 text-[13px]">
          <thead className="bg-slate-50/95 text-[10px] uppercase tracking-[0.06em] text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Rep</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Revenue</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Won</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Lost</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Win %</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">Avg deal</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">Activity</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">Emails</th>
              <th scope="col" className="hidden px-3 py-2 text-right font-medium lg:table-cell">Tasks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, idx) => (
              <RepRow
                key={row.ownerId}
                row={row}
                rank={idx + 1}
                currency={currency}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RepRow({
  row,
  rank,
  currency,
}: {
  row: RepPerformanceRow;
  rank: number;
  currency: TenantCurrencyContext;
}) {
  const winPct = Math.round(row.winRate * 100);
  return (
    <tr className="transition-colors hover:bg-slate-50/70">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">
            {rank}
          </span>
          {row.ownerImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.ownerImageUrl}
              alt=""
              className="h-5 w-5 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
            />
          ) : (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-700 ring-1 ring-slate-200">
              {initialsOf(row.ownerDisplayName)}
            </span>
          )}
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-800">
              {row.ownerDisplayName}
            </div>
            {row.ownerEmail ? (
              <div className="truncate text-[10.5px] text-slate-500">
                {row.ownerEmail}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900">
        {formatTenantCurrency(row.revenueMinor, currency)}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-700">
        {row.wonCount}
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-rose-600">
        {row.lostCount}
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right font-mono tabular-nums',
          row.wonCount + row.lostCount === 0
            ? 'text-slate-400'
            : winPct >= 60
              ? 'text-emerald-700'
              : winPct >= 40
                ? 'text-slate-700'
                : 'text-rose-600',
        )}
      >
        {row.wonCount + row.lostCount === 0 ? '—' : `${winPct}%`}
      </td>
      <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-700 md:table-cell">
        {row.wonCount === 0
          ? '—'
          : formatTenantCurrency(row.avgWonAmountMinor, currency)}
      </td>
      <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-700 lg:table-cell">
        {formatNumber(row.activityCount)}
      </td>
      <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-700 lg:table-cell">
        {formatNumber(row.emailCount)}
      </td>
      <td className="hidden px-3 py-2 text-right font-mono tabular-nums text-slate-700 lg:table-cell">
        {formatNumber(row.tasksCompleted)}
      </td>
    </tr>
  );
}

function shortName(displayName: string): string {
  if (displayName.length <= 16) return displayName;
  // First name + first initial of last name
  const parts = displayName.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
  }
  return displayName.slice(0, 16);
}

function initialsOf(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  );
}
