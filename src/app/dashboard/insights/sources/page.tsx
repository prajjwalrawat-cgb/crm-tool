import { can } from '@/lib/rbac';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { sourceRoiReport } from '@/lib/reports/manager/services';

import { PageHeader, rangeQuery } from '../_components/page-header';
import { SourceRoiTable } from '../_components/source-roi-table';
import { ExportLink } from '../_components/ui';

/** Lead-source ROI with inline monthly spend. */
export default async function SourcesPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const data = await sourceRoiReport(ctx.scope, ctx.range);
    const month = ctx.range.toDay.slice(0, 7);
    return (
      <>
        <PageHeader
          ctx={ctx}
          title="Lead sources"
          description="Where leads come from and what they turn into."
          actions={<ExportLink report="source-roi" query={rangeQuery(ctx)} />}
        />
        <SourceRoiTable rows={data.rows} currency={ctx.currency} showSpend={data.showSpend} canEditSpend={can(ctx.membership.role, 'manageForecast')} month={month} />
        <p className="mt-2 text-[11.5px] text-slate-500">
          {data.showSpend
            ? `Spend counts every month the period touches (${data.spendMonths.join(', ') || 'none entered yet'}). Click a spend cell to set ${month}.`
            : 'Spend and ROI are workspace-wide, so they show only to admins and to managers who see the whole workspace.'}{' '}
          Qualified % follows the leads created in the period; won counts deals closed in the period.
        </p>
      </>
    );
  });
}
