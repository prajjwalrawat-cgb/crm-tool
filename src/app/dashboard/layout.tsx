import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getAIMode } from '@/lib/ai/config';
import { auth } from '@/lib/auth/server';
import { displayNameForUser, getUserById } from '@/lib/auth/users';
import { listUserWorkspaces } from '@/lib/auth/workspaces';
import { runWithTenantContext } from '@/lib/db-context';
import { ensureMembership } from '@/lib/membership';
import { listNotificationsForUser } from '@/lib/notifications/queries';
import { personaOf } from '@/lib/personas';
import { ensureTenant } from '@/lib/tenant';

import { DashboardShell } from './_components/dashboard-shell';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // auth() is a cheap cookie/JWT read (no DB); resolve it + the tenant
  // first since the redirect gate and every fetch below depends on them.
  const { userId } = await auth();
  const tenant = await ensureTenant();

  if (!tenant) {
    // The middleware should have caught this, but if a race left us
    // tenant-less, take the user to the selector instead of crashing.
    redirect('/select-org');
  }

  // Everything else is independent — fan out in parallel instead of a
  // serial await chain. With the larger pool (see src/db/index.ts) these
  // genuinely run concurrently; the per-request cache() de-dupes the
  // membership/tenant/user lookups the pages below repeat.
  const [membership, initialNotifications, userRow, workspacesRaw] =
    await Promise.all([
      ensureMembership(),
      userId
        ? runWithTenantContext({ tenantId: tenant.id, userId }, () =>
            listNotificationsForUser(tenant.id, userId, { limit: 30 }),
          )
        : Promise.resolve([]),
      userId ? getUserById(userId) : Promise.resolve(null),
      userId ? listUserWorkspaces(userId) : Promise.resolve([]),
    ]);

  const persona = personaOf(membership?.role ?? null);
  const account = {
    displayName: userRow ? displayNameForUser(userRow) : 'Account',
    email: userRow?.email ?? null,
    imageUrl: userRow?.imageUrl ?? null,
  };
  const workspaces = workspacesRaw.map((w) => ({
    tenantId: w.tenantId,
    name: w.name,
  }));
  // Only the OWNER of the *active* workspace may create new workspaces and
  // see the owner-only Organizations tab.
  const isOwner = membership?.role === 'owner';
  const canCreate = isOwner;

  return (
    <DashboardShell
      tenantId={tenant.id}
      currentUserId={userId ?? ''}
      initialNotifications={initialNotifications}
      aiMode={getAIMode()}
      persona={persona}
      account={account}
      currentTenantName={tenant.name}
      workspaces={workspaces}
      canCreateWorkspace={canCreate}
      isOwner={isOwner}
    >
      {children}
    </DashboardShell>
  );
}
