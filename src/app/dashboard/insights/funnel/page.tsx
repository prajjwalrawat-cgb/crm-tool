import Link from 'next/link';

import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { funnel, listSources } from '@/lib/reports/manager/services';

import { FunnelView } from '../_components/funnel-view';
import { PageHeader, rangeQuery } from '../_components/page-header';

/** Cohort funnel: leads created in range → stages reached, with drill-down per bar. */
export default async function FunnelPage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const sourceId = ctx.params.sourceId && /^[0-9a-f-]{36}$|^none$/i.test(ctx.params.sourceId) ? ctx.params.sourceId : null;
    const ownerId = ctx.params.ownerId || null;
    const [data, sources] = await Promise.all([
      funnel(ctx.scope, ctx.range, { sourceId, ownerId }),
      listSources(ctx.tenant.id),
    ]);
    const q = { ...rangeQuery(ctx), ...(sourceId ? { sourceId } : {}), ...(ownerId ? { ownerId } : {}) };
    const base = new URLSearchParams(rangeQuery(ctx));
    return (
      <>
        <PageHeader ctx={ctx} title="Funnel" description="Leads created in the period, and how far each one got." />
        <div className="mb-3 flex flex-wrap items-center gap-1 text-[12px]">
          <span className="text-slate-500">Source:</span>
          <Link href={`?${base}`} className={`rounded px-2 py-0.5 ${!sourceId ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
            All
          </Link>
          {[...sources, { id: 'none', name: 'No source' }].map((s) => (
            <Link key={s.id} href={`?${new URLSearchParams({ ...Object.fromEntries(base), sourceId: s.id })}`} className={`rounded px-2 py-0.5 ${sourceId === s.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              {s.name}
            </Link>
          ))}
        </div>
        <FunnelView steps={data.steps} cohortSize={data.cohortSize} query={q} />
      </>
    );
  });
}
