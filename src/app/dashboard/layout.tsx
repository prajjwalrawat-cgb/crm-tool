import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getAIMode } from '@/lib/ai/config';
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
  // Backstop the org→tenant + membership sync once per dashboard render.
  // Both helpers self-establish a tenant context for their RLS-touching
  // writes (memberships table) — the layout doesn't need to wrap them.
  // Page-level data fetches enter their own context via withTenantSession.
  const tenant = await ensureTenant();
  const membership = await ensureMembership();
  const persona = personaOf(membership?.role ?? null);

  if (!tenant) {
    // The middleware should have caught this, but if a race left us
    // tenant-less, take the user to the selector instead of crashing.
    redirect('/select-org');
  }

  const { userId } = await auth();
  // Pre-fetch the user's recent notifications so the bell renders with
  // content on first paint. The dropdown stays live afterwards via the
  // tenant SSE stream — see notification-bell.tsx.
  const initialNotifications = userId
    ? await runWithTenantContext({ tenantId: tenant.id, userId }, () =>
        listNotificationsForUser(tenant.id, userId, { limit: 30 }),
      )
    : [];

  return (
    <DashboardShell
      tenantId={tenant.id}
      currentUserId={userId ?? ''}
      initialNotifications={initialNotifications}
      aiMode={getAIMode()}
      persona={persona}
    >
      {children}
    </DashboardShell>
  );
}
