import Link from 'next/link';

import { fmt } from '@/lib/reports/manager/format';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { pipelineDeals, teamPipeline } from '@/lib/reports/manager/services';

import { PageHeader } from '../_components/page-header';

/**
 * Team pipeline board: stages as columns, reps as rows of counts inside
 * each. Read-only (no drag). Stale badge = no activity for N days.
 * Clicking a rep opens that rep's deals in that stage below the board.
 */
export default async function TeamPipelinePage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const staleDays = Math.min(365, Math.max(1, Number(ctx.params.staleDays ?? 7) || 7));
    const stage = ctx.params.stage ?? null;
    const owner = ctx.params.owner ?? null;
    const [d, list] = await Promise.all([teamPipeline(ctx.scope, staleDays), stage ? pipelineDeals(ctx.scope, stage, owner, staleDays) : Promise.resolve(null)]);
    return (
      <>
        <PageHeader ctx={ctx} title="Team pipeline" description={`Open deals right now, by stage and rep. Stale = no activity for ${staleDays}+ days.`} showRange={false} />
        <div className="grid gap-3 overflow-x-auto md:grid-cols-5">
          {d.columns.map((c) => (
            <section key={c.stage} className="min-w-[200px] rounded-lg border border-slate-200 bg-white">
              <header className="border-b border-slate-100 px-3 py-2">
                <h3 className="text-[12.5px] font-semibold capitalize text-slate-900">{c.stage}</h3>
                <p className="text-[11.5px] text-slate-500">
                  {c.count} deals · {fmt('currency', c.value, ctx.currency, true)}
                  {c.stale > 0 && <span className="ml-1 rounded bg-rose-100 px-1 font-medium text-rose-800">{c.stale} stale</span>}
                </p>
              </header>
              <ul className="divide-y divide-slate-100">
                {c.reps.length === 0 && <li className="px-3 py-3 text-[12px] text-slate-400">No deals</li>}
                {c.reps.map((r) => (
                  <li key={r.userId ?? 'none'}>
                    <Link
                      href={`?staleDays=${staleDays}&stage=${c.stage}&owner=${encodeURIComponent(r.userId ?? '')}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-[12.5px] hover:bg-slate-50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700" aria-hidden>
                          {r.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
                        </span>
                        <span className="truncate text-slate-800">{r.name}</span>
                      </span>
                      <span className="shrink-0 text-right tabular-nums text-slate-900">
                        {r.count}
                        {r.stale > 0 && (
                          <span className="ml-1 rounded-full bg-rose-600 px-1.5 text-[10px] font-semibold text-white" title={`${r.stale} stale`}>
                            {r.stale}
                            <span className="sr-only"> stale</span>
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        {list && (
          <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-[13px] font-semibold capitalize text-slate-900">
              {stage} · {list[0]?.ownerName ?? (owner ? 'this rep' : 'everyone')} · {list.length} deals
            </h3>
            <ul className="mt-2 divide-y divide-slate-100 text-[12.5px]">
              {list.map((x) => (
                <li key={x.dealId} className="flex items-center justify-between gap-2 py-1.5">
                  <Link href={`/dashboard/deals/${x.dealId}`} className="truncate text-slate-900 hover:underline">
                    {x.name}
                  </Link>
                  <span className="shrink-0 tabular-nums text-slate-600">
                    {fmt('currency', x.value, ctx.currency)} · {x.idleDays} d idle
                    {x.stale && <span className="ml-1 rounded bg-rose-100 px-1 font-medium text-rose-800">stale</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </>
    );
  });
}
