import type { ReactNode } from 'react';

import { ensureTenant } from '@/lib/tenant';

import { DashboardShell } from './_components/dashboard-shell';

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Backstop the org→tenant sync once per dashboard render so children can
  // rely on the row existing without re-running the Clerk SDK fetch.
  await ensureTenant();

  return <DashboardShell>{children}</DashboardShell>;
}
