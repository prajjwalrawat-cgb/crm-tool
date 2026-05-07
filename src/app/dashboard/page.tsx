import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { auth, currentUser } from '@clerk/nextjs/server';

import { ensureTenant } from '@/lib/tenant';

export const metadata = {
  title: 'Dashboard',
};

export default async function DashboardPage() {
  // Middleware already gated this route on userId + orgId. ensureTenant
  // backstops the webhook in case a row hasn't been provisioned yet.
  const [{ userId, orgId }, user, tenant] = await Promise.all([
    auth(),
    currentUser(),
    ensureTenant(),
  ]);

  return (
    <main className="flex min-h-screen flex-col px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Welcome back{user?.firstName ? `, ${user.firstName}` : ''}.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <OrganizationSwitcher
            hidePersonal
            afterCreateOrganizationUrl="/dashboard"
            afterSelectOrganizationUrl="/dashboard"
            afterLeaveOrganizationUrl="/select-org"
          />
          <UserButton />
        </div>
      </header>

      <section className="mt-8 grid gap-4 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">User ID</div>
          <div className="mt-1 break-all font-mono">{userId}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Active Org</div>
          <div className="mt-1 break-all font-mono">{orgId ?? '(none)'}</div>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 sm:col-span-2 dark:border-zinc-800">
          <div className="text-xs uppercase tracking-wide text-zinc-500">Tenant row</div>
          {tenant ? (
            <dl className="mt-2 grid gap-2 sm:grid-cols-3 sm:gap-4">
              <div>
                <dt className="text-xs text-zinc-500">name</dt>
                <dd className="font-medium">{tenant.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">slug</dt>
                <dd className="font-mono">{tenant.slug}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">id</dt>
                <dd className="break-all font-mono text-xs">{tenant.id}</dd>
              </div>
            </dl>
          ) : (
            <div className="mt-1 text-zinc-500">No tenant row yet.</div>
          )}
        </div>
      </section>
    </main>
  );
}
