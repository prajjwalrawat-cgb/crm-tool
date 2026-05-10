import { auth } from '@clerk/nextjs/server';

import { withTenantSession } from '@/lib/auth-guard';
import { requireMembership } from '@/lib/membership';
import { listPendingInvitations, listTeamMembers } from '@/lib/team/queries';

import { TeamView } from './_components/team-view';

export const metadata = {
  title: 'Team',
};

export default async function TeamPage() {
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
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {tenant.name}
          </p>
        </header>

        <TeamView
          members={members}
          pendingInvitations={pendingInvitations}
          currentRole={currentMembership.role}
          currentUserId={userId}
        />
      </main>
    );
  });
}
