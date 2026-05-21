import { auth } from '@clerk/nextjs/server';
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

  if (!tenant) {
    // The middleware should have redirected to /select-org before reaching
    // here, but if a race left us tenant-less, surface a hard error rather
    // than render a broken shell.
    throw new Error(
      'No active tenant. Pick or create an organization in /select-org.',
    );
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

  const persona = personaOf(membership?.role ?? null);

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
