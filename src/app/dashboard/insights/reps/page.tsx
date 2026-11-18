import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { repProductivity } from '@/lib/reports/manager/services';

import { PageHeader, rangeQuery } from '../_components/page-header';
import { RepTable } from '../_components/rep-table';
import { ExportLink } from '../_components/ui';

export default async function RepsPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const data = await repProductivity(ctx.scope, ctx.range);
    return (
      <>
        <PageHeader ctx={ctx} title="Rep productivity" description="Activity and results per rep." actions={<ExportLink report="rep-productivity" query={rangeQuery(ctx)} />} />
        <RepTable rows={data.rows} medians={data.medians} currency={ctx.currency} query={rangeQuery(ctx)} />
      </>
    );
  });
}
