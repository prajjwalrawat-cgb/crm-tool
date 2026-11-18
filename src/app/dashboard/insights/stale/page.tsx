import Link from 'next/link';

import { can } from '@/lib/rbac';
import { withReportPage, type SearchParams } from '@/lib/reports/manager/page-context';
import { staleLeads } from '@/lib/reports/manager/services';

import { PageHeader } from '../_components/page-header';
import { StaleTable } from '../_components/stale-table';
import { ExportLink } from '../_components/ui';

const OPTIONS = [3, 7, 14, 30];

export default async function StalePage({ searchParams }: { searchParams: SearchParams }) {
  return await withReportPage(searchParams, async (ctx) => {
    const days = Math.min(365, Math.max(1, Number(ctx.params.days ?? 7) || 7));
    const d = await staleLeads(ctx.scope, days, ctx.params.ownerId || null);
    return (
      <>
        <PageHeader
          ctx={ctx}
          title="Stale leads"
          description={`Open deals with no activity for more than ${days} days, oldest first.`}
          showRange={false}
          actions={
            <>
              <div className="flex gap-1 text-[12px]">
                {OPTIONS.map((n) => (
                  <Link key={n} href={`?days=${n}`} className={`rounded px-2 py-0.5 ${n === days ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                    {n}d
                  </Link>
                ))}
              </div>
              <ExportLink report="stale-leads" query={{ days: String(days) }} />
            </>
          }
        />
        <StaleTable rows={d.rows} days={days} currency={ctx.currency} canReassign={can(ctx.membership.role, 'assignDeals') || ctx.membership.role === 'admin'} />
      </>
    );
  });
}
