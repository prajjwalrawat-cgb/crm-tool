import { listRecentActivity } from '@/lib/activity/queries';
import { requireTenant } from '@/lib/tenant';

import { ActivityList } from './_components/activity-list';

export const metadata = {
  title: 'Activity',
};

export default async function ActivityPage() {
  const tenant = await requireTenant();
  const rows = await listRecentActivity(tenant.id, { limit: 100 });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {tenant.name} — most recent 100 events.
        </p>
      </header>
      <ActivityList rows={rows} />
    </main>
  );
}
