import { listRecentActivity } from '@/lib/activity/queries';
import { withTenantSession } from '@/lib/auth-guard';
import { parseCursorParam, parsePageSize } from '@/lib/pagination/cursor';
import { requirePersonas } from '@/lib/personas/guards';

import { LiveActivityFeed } from './_components/live-activity-feed';

export const metadata = {
  title: 'Activity',
};

type SearchParams = Promise<{
  cursor?: string;
  size?: string;
}>;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const sp = await searchParams;
    const cursor = parseCursorParam(sp.cursor);
    const size = parsePageSize(sp.size);

    const page = await listRecentActivity(tenant.id, { cursor, size });

    return (
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Activity</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name} — paginated audit feed.
          </p>
        </header>
        <LiveActivityFeed
          tenantId={tenant.id}
          initialRows={page.items}
          nextCursor={page.nextCursor}
          pageSize={page.size}
          liveUpdates={cursor === null}
        />
      </main>
    );
  });
}
