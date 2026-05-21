import { auth } from '@clerk/nextjs/server';

import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { requirePersonas } from '@/lib/personas/guards';
import { listPendingInvitations, listTeamMembers } from '@/lib/team/queries';

import { TeamView } from './_components/team-view';

export const metadata = {
  title: 'Team',
};

export default async function TeamPage() {
  await requirePersonas(['manager', 'admin']);
  return await withTenantSession(async ({ tenant }) => {
    const { userId, orgId } = await auth();

    if (!orgId || !userId) {
      throw new Error('Active organization is required to view the team page.');
    }

    const [currentMembership, members, pendingInvitations] = await Promise.all([
      requireMembership(),
      listTeamMembers(tenant.id),
      listPendingInvitations(orgId),
    ]);

    return (
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 sm:px-5 lg:px-6">
        <header className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Team</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name}
          </p>
        </header>

        <TeamView
          members={members}
          pendingInvitations={pendingInvitations}
          currentRole={currentMembership.role}
          currentUserId={userId}
          tenantName={tenant.name}
        />
      </main>
    );
  });
}
