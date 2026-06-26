import { redirect } from 'next/navigation';

import { withTenantSession } from '@/lib/auth-guard';
import { listUserWorkspaces } from '@/lib/auth/workspaces';
import { isOwner, requireMembership } from '@/lib/membership';

import { OrganizationsManager } from './_components/organizations-manager';

export const metadata = { title: 'Organizations' };

export default async function OrganizationsPage() {
  return await withTenantSession(async ({ tenant, userId }) => {
    // Owner-only surface. Members/managers/admins are bounced to the dashboard.
    const membership = await requireMembership();
    if (!isOwner(membership)) redirect('/dashboard');

    const owned = (await listUserWorkspaces(userId)).filter(
      (w) => w.role === 'owner',
    );

    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Organizations
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Manage the workspaces you own — rename or delete them.
          </p>
        </header>

        <OrganizationsManager owned={owned} activeTenantId={tenant.id} />
      </main>
    );
  });
}
