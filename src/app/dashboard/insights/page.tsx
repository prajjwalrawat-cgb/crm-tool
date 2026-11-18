import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { summary } from '@/lib/reports/manager/services';

import { KpiStrip, NarrativeCard } from './_components/overview';
import { PageHeader, rangeQuery } from './_components/page-header';
import { Card } from './_components/ui';

/** Reports home: KPI strip with deltas + sparklines, AI narrative on top. */
export default async function InsightsHome({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const data = await summary(ctx.scope, ctx.range, ctx.compare);
    const q = rangeQuery(ctx);
    const live = data.servedBy.every((s) => s.source === 'live');
    return (
      <>
        <PageHeader ctx={ctx} title="Overview" description="The numbers managers check every day." showCompare />
        <div className="space-y-4">
          <NarrativeCard key={JSON.stringify(q)} query={q} />
          <KpiStrip tiles={data.tiles} currency={ctx.currency} query={q} />
          <Card>
            <dl className="grid grid-cols-2 gap-3 text-[12.5px] sm:grid-cols-4 lg:grid-cols-8">
              {(
                [
                  ['Qualified', data.totals.qualified],
                  ['Proposals', data.totals.quotesSent],
                  ['Deals won', data.totals.wonCount],
                  ['Deals lost', data.totals.lostCount],
                  ['Calls made', data.totals.callsMade],
                  ['Emails sent', data.totals.emailsSent],
                  ['Meetings', data.totals.meetingsHeld],
                  ['Reps', data.reps],
                ] as const
              ).map(([label, v]) => (
                <div key={label}>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900">{Number(v).toLocaleString('en-IN')}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <p className="text-[11px] text-slate-400">
            {live ? 'Computed live.' : 'Past days come from the daily rollup (refreshed every 15 minutes); today is live.'} Click a tile to see the rows behind it.
          </p>
        </div>
      </>
    );
  });
}
