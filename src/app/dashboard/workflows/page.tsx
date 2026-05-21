import { withTenantSession } from '@/lib/auth-guard';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { requirePersonas } from '@/lib/personas/guards';
import { listWorkflowRuns } from '@/lib/workflows/queries';

import { PaginationControls } from '../_components/pagination-controls';
import { WorkflowRunsList } from './_components/workflow-runs-list';

export const metadata = {
  title: 'Workflows',
};

type SearchParams = Promise<{
  cursor?: string;
  size?: string;
}>;

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const cursor = parseCursorParam(sp.cursor);
    const size = parsePageSize(sp.size);

    const page = await listWorkflowRuns(tenant.id, { cursor, size });

    const counts = page.items.reduce(
      (acc, r) => {
        acc[r.status as keyof typeof acc] =
          (acc[r.status as keyof typeof acc] ?? 0) + 1;
        return acc;
      },
      { running: 0, completed: 0, failed: 0, skipped: 0 },
    );

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Workflows</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name} — paginated by start time. Counts below reflect this
            page only.
          </p>
        </header>

        <section className="mb-6 grid gap-3 sm:grid-cols-4">
          <Stat label="Running" value={counts.running} accent="blue" />
          <Stat label="Completed" value={counts.completed} accent="emerald" />
          <Stat label="Failed" value={counts.failed} accent="red" />
          <Stat label="Skipped" value={counts.skipped} accent="zinc" />
        </section>

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <WorkflowRunsList rows={page.items} />
          <PaginationControls
            basePath="/dashboard/workflows"
            nextCursor={page.nextCursor}
            size={page.size}
            visibleCount={page.items.length}
          />
        </div>
      </main>
    );
  });
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'blue' | 'emerald' | 'red' | 'zinc';
}) {
  const accentClass = {
    blue: 'text-blue-600',
    emerald: 'text-emerald-600',
    red: 'text-red-600',
    zinc: 'text-slate-600',
  }[accent];

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold ${accentClass}`}>{value}</div>
    </div>
  );
}
