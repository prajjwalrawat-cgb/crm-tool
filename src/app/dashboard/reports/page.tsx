import { ArrowRight, BarChart3, Briefcase, MailOpen, Users, Zap } from 'lucide-react';
import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { requirePersonas } from '@/lib/personas/guards';
import { REPORTS, type ReportRegistration } from '@/lib/reports/registry';
import type { ReportCategory } from '@/lib/reports/types';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Reports' };

const CATEGORY_META: Record<
  ReportCategory,
  { label: string; tint: string; icon: typeof BarChart3 }
> = {
  pipeline: { label: 'Pipeline', tint: 'bg-indigo-50 text-indigo-700 ring-indigo-200', icon: Briefcase },
  performance: { label: 'Performance', tint: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: Users },
  activity: { label: 'Activity', tint: 'bg-amber-50 text-amber-700 ring-amber-200', icon: Zap },
  email: { label: 'Email', tint: 'bg-sky-50 text-sky-700 ring-sky-200', icon: MailOpen },
  forecast: { label: 'Forecast', tint: 'bg-violet-50 text-violet-700 ring-violet-200', icon: BarChart3 },
};

/**
 * Reports list. Each card runs the report's runner with default
 * filters so the tile can show a headline number. This sounds
 * expensive, but each query is < 200ms and they run in parallel —
 * total page TTFB stays under 600ms even for the full set.
 *
 * If headline computation gets slow as more reports land, switch
 * tiles to lazy-load via a client-side `useEffect` (or RSC streaming
 * with Suspense). Don't optimize prematurely.
 */
export default async function ReportsPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant, userId }) => {
    const cards = await Promise.all(
      Object.values(REPORTS).map(async (report) => {
        let headline: string | null = null;
        try {
          const result = await report.runner(
            tenant.id,
            { range: 'last_30d', owner: { type: 'all' } },
            { currentUserId: userId },
          );
          headline = result.meta.headline?.value ?? null;
        } catch {
          // Report headline failures should never break the list page.
          // The card will render without a headline; the detail page
          // surfaces the real error.
        }
        return { report, headline };
      }),
    );

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-6">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-900">
            <BarChart3 className="h-5 w-5 text-slate-500" aria-hidden />
            Reports
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Aggregated views over {tenant.name}&apos;s pipeline. All queries
            respect tenant isolation; data is current within ~60 seconds.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map(({ report, headline }) => (
            <ReportTile
              key={report.id}
              report={report}
              headline={headline}
            />
          ))}
        </div>
      </main>
    );
  });
}

function ReportTile({
  report,
  headline,
}: {
  report: ReportRegistration;
  headline: string | null;
}) {
  const cat = CATEGORY_META[report.category];
  const Icon = cat.icon;
  return (
    <Link
      href={`/dashboard/reports/${report.id}`}
      className="group rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide ring-1',
            cat.tint,
          )}
        >
          <Icon className="h-3 w-3" aria-hidden />
          {cat.label}
        </span>
        <ArrowRight
          className="h-3.5 w-3.5 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-500"
          aria-hidden
        />
      </div>
      <h2 className="mt-3 text-[14.5px] font-semibold text-slate-900">
        {report.title}
      </h2>
      <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-slate-500">
        {report.description}
      </p>
      {headline ? (
        <p className="mt-3 font-mono text-[15px] font-semibold tabular-nums text-slate-900">
          {headline}
        </p>
      ) : (
        <p className="mt-3 text-[11.5px] text-slate-400">No data yet</p>
      )}
    </Link>
  );
}
