import type { ReactNode } from 'react';

import { getAIMode } from '@/lib/ai/config';
import { ensureMembership } from '@/lib/membership';
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
  await ensureMembership();

  if (!tenant) {
    // The middleware should have redirected to /select-org before reaching
    // here, but if a race left us tenant-less, surface a hard error rather
    // than render a broken shell.
    throw new Error(
      'No active tenant. Pick or create an organization in /select-org.',
    );
  }

  return (
    <DashboardShell tenantId={tenant.id} aiMode={getAIMode()}>
      {children}
    </DashboardShell>
  );
}
