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
import type {
  EmailEngagementExtras,
  EmailEngagementRow,
} from '@/lib/reports/queries/email-engagement';
import { cn } from '@/lib/utils';

import { MetricCard } from '../../_components/metric-card';

const STATUS_COLORS: Record<EmailEngagementRow['status'], string> = {
  sent: '#059669',
  delivered: '#10b981',
  failed: '#e11d48',
  queued: '#94a3b8',
  sending: '#3b82f6',
};

const STATUS_LABELS: Record<EmailEngagementRow['status'], string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  queued: 'Queued',
  sending: 'Sending',
};

/**
 * Email Engagement section. Top: 4 KPI tiles (delivered / failed /
 * retry rate / volume). Below: distribution bar chart by status.
 * Below that: a small table with the raw counts.
 *
 * The KPI tiles do most of the executive lifting; the chart is for
 * "where is the problem?" pattern-matching.
 */
export function EmailEngagementSection({
  rows,
  extras,
}: {
  rows: EmailEngagementRow[];
  extras: EmailEngagementExtras;
}) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  const sent = rows.find((r) => r.status === 'sent')?.count ?? 0;
  const delivered = rows.find((r) => r.status === 'delivered')?.count ?? 0;
  const failed = rows.find((r) => r.status === 'failed')?.count ?? 0;

  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center text-[12.5px] text-slate-500">
        No outbound emails in this window. Try a wider date range or send a
        test from a deal page.
      </div>
    );
  }

  const chartData = rows
    .filter((r) => r.count > 0)
    .map((r) => ({
      status: STATUS_LABELS[r.status],
      statusKey: r.status,
      count: r.count,
    }));

  const successRatePct = Math.round(extras.successRate * 100);
  const retryRatePct = Math.round(extras.retryRate * 100);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          label="Delivered"
          value={`${successRatePct}%`}
          hint={`${sent + delivered} of ${total} attempts`}
          tone={
            successRatePct >= 95
              ? 'success'
              : successRatePct >= 80
                ? 'warning'
                : 'danger'
          }
        />
        <MetricCard
          label="Failed"
          value={formatNumber(failed)}
          hint={total > 0 ? `${Math.round((failed / total) * 100)}% of total` : '—'}
          tone={
            failed === 0
              ? 'success'
              : failed / total < 0.05
                ? 'warning'
                : 'danger'
          }
        />
        <MetricCard
          label="Retry rate"
          value={`${retryRatePct}%`}
          hint="Retries per attempt"
          tone={
            retryRatePct < 5
              ? 'success'
              : retryRatePct < 15
                ? 'warning'
                : 'danger'
          }
        />
        <MetricCard
          label="Volume"
          value={formatNumber(total)}
          hint="Total attempts"
          tone="neutral"
        />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Status distribution
        </div>
        <div className="h-[260px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 16, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="status"
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
                tickFormatter={(v: number) => formatNumber(v)}
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
                  return [formatNumber(num), 'Attempts'];
                }}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={56}>
                {chartData.map((d) => (
                  <Cell key={d.statusKey} fill={STATUS_COLORS[d.statusKey]} />
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
              <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Count</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Retries</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                key={row.status}
                className={cn(
                  'transition-colors hover:bg-slate-50/70',
                  row.count === 0 && 'text-slate-400',
                )}
              >
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: STATUS_COLORS[row.status] }}
                      aria-hidden
                    />
                    {STATUS_LABELS[row.status]}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatNumber(row.count)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">
                  {row.retrySum === 0 ? '—' : formatNumber(row.retrySum)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-500">
                  {total === 0 ? '—' : `${Math.round((row.count / total) * 100)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Local KpiTile removed — replaced by the shared <MetricCard /> primitive
// in `app/dashboard/_components/metric-card.tsx`.
