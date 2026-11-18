import { can } from '@/lib/rbac';
import { fmt } from '@/lib/reports/manager/format';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { slaReport } from '@/lib/reports/manager/services';

import { PageHeader, rangeQuery } from '../_components/page-header';
import { BreachList, SlaHeatmap, SlaTrend } from '../_components/sla-view';
import { Card, ExportLink } from '../_components/ui';

/** First-response SLA: trend, hour × weekday heatmap, by rep / source, breach list. */
export default async function SlaPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const d = await slaReport(ctx.scope, ctx.range);
    const canReassign = can(ctx.membership.role, 'assignDeals') || ctx.membership.role === 'admin';
    return (
      <>
        <PageHeader ctx={ctx} title="SLA & response time" description="How fast assigned leads get their first call, email or note." actions={<ExportLink report="sla-breaches" query={rangeQuery(ctx)} />} />
        <div className="grid gap-4 lg:grid-cols-4">
          {(
            [
              ['SLA met', fmt('percent', d.overall.compliancePct, ctx.currency)],
              ['Breaches', String(d.overall.breached)],
              ['Median first response', fmt('minutes', d.overall.medianFirstResponseMin, ctx.currency)],
              ['90th percentile', fmt('minutes', d.overall.p90FirstResponseMin, ctx.currency)],
            ] as const
          ).map(([l, v]) => (
            <Card key={l}>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">{l}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{v}</div>
            </Card>
          ))}
          <Card title="SLA met by day" className="lg:col-span-2">
            <SlaTrend data={d.trend} />
          </Card>
          <Card title="When breaches happen" className="lg:col-span-2">
            <SlaHeatmap cells={d.heatmap} />
          </Card>
          <Card title="By rep" className="lg:col-span-2">
            <SimpleTable rows={d.byRep.map((r) => [r.name, r.due, r.breached, fmt('percent', r.compliancePct, ctx.currency), fmt('minutes', r.medianFirstResponseMin, ctx.currency)])} />
          </Card>
          <Card title="By source" className="lg:col-span-2">
            <SimpleTable rows={d.bySource.map((r) => [r.name, r.due, r.breached, fmt('percent', r.compliancePct, ctx.currency), fmt('minutes', r.medianFirstResponseMin, ctx.currency)])} />
          </Card>
          <div className="lg:col-span-4">
            <BreachList rows={d.breaches} canReassign={canReassign} />
          </div>
        </div>
      </>
    );
  });
}

function SimpleTable({ rows }: { rows: Array<[string, number, number, string, string]> }) {
  if (rows.length === 0) return <p className="text-[12.5px] text-slate-500">No assignments in this period.</p>;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-[12.5px]">
        <thead className="sticky top-0 bg-white text-left text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-1.5">Name</th>
            <th className="text-right">Due</th>
            <th className="text-right">Breached</th>
            <th className="text-right">Met</th>
            <th className="text-right">Median</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([n, due, br, met, med]) => (
            <tr key={n} className="border-t border-slate-100">
              <td className="py-1.5 text-slate-900">{n}</td>
              <td className="text-right tabular-nums">{due}</td>
              <td className="text-right tabular-nums">{br}</td>
              <td className="text-right tabular-nums">{met}</td>
              <td className="text-right tabular-nums">{med}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
