import Link from 'next/link';
import { notFound } from 'next/navigation';

import { fmt } from '@/lib/reports/manager/format';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { repDetail } from '@/lib/reports/manager/services';

import { DailyBars } from '../../_components/lazy';
import { PageHeader, rangeQuery } from '../../_components/page-header';
import { Card, EmptyState, VIZ } from '../../_components/ui';

/** One rep: daily activity chart, recent calls, open pipeline by stage. */
export default async function RepDetailPage({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: SearchParams }) {
  const { userId } = await params;
  return await withReportPage(searchParams, async (ctx) => {
    const d = await repDetail(ctx.scope, ctx.range, decodeURIComponent(userId));
    if (!d) notFound();
    const back = new URLSearchParams(rangeQuery(ctx)).toString();
    return (
      <>
        <PageHeader ctx={ctx} title={d.person.name} description="Daily activity, calls and open pipeline." actions={<Link href={`/dashboard/insights/reps?${back}`} className="text-[12px] text-slate-600 hover:underline">← All reps</Link>} />
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Activities per day" className={`lg:col-span-2 ${VIZ}`}>
            <DailyBars data={d.daily.map((x) => ({ day: x.day, value: x.activities }))} label="Activities" />
          </Card>
          <Card title="Open pipeline">
            <p className="text-xl font-semibold tabular-nums text-slate-900">{fmt('currency', d.pipeline.openValue, ctx.currency)}</p>
            <p className="text-[12px] text-slate-500">
              {d.pipeline.openCount} open deals · weighted {fmt('currency', d.pipeline.weightedValue, ctx.currency)}
            </p>
            <ul className="mt-3 space-y-1 text-[12.5px]">
              {d.pipeline.byStage.map((s) => (
                <li key={s.stage} className="flex justify-between">
                  <span className="capitalize text-slate-700">{s.stage}</span>
                  <span className="tabular-nums text-slate-900">
                    {s.count} · {fmt('currency', s.value, ctx.currency, true)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Recent calls" className="lg:col-span-3">
            {d.calls.length === 0 ? (
              <EmptyState title="No calls in this period" />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1.5">When</th>
                    <th>Lead</th>
                    <th>Status</th>
                    <th>Disposition</th>
                    <th className="text-right">Talk</th>
                  </tr>
                </thead>
                <tbody>
                  {d.calls.map((c) => (
                    <tr key={c.id} className="border-t border-slate-100">
                      <td className="py-1.5">{c.started_at ? new Date(c.started_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                      <td>{c.lead_id ? <Link href={`/dashboard/deals/${c.lead_id}`} className="hover:underline">{c.deal_name ?? 'Lead'}</Link> : '—'}</td>
                      <td className="capitalize">{c.status.replace('_', ' ')}</td>
                      <td className="capitalize">{c.disposition?.replace('_', ' ') ?? '—'}</td>
                      <td className="text-right tabular-nums">{c.talk_time_sec ? `${Math.round(c.talk_time_sec / 60)} min` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </>
    );
  });
}
