import { redirect } from 'next/navigation';

import { AuthShell } from '@/components/auth/auth-shell';
import { CreateWorkspaceForm } from '@/components/auth/create-workspace-form';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { WorkspacePicker } from '@/components/auth/workspace-picker';
import { auth } from '@/lib/auth/server';
import { canCreateWorkspace, listUserWorkspaces } from '@/lib/auth/workspaces';

export const metadata = {
  title: 'Select workspace',
};

export default async function SelectOrgPage() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  const workspaces = await listUserWorkspaces(userId);
  const hasWorkspaces = workspaces.length > 0;
  const canCreate = await canCreateWorkspace(userId);

  return (
    <AuthShell
      subtitle={
        hasWorkspaces
          ? 'Choose a workspace to continue.'
          : canCreate
            ? "You're not in a workspace yet. Create one to get started."
            : "You're not in a workspace yet. Ask an admin to invite you."
      }
    >
      {hasWorkspaces ? <WorkspacePicker workspaces={workspaces} /> : null}
      {canCreate ? <CreateWorkspaceForm hasWorkspaces={hasWorkspaces} /> : null}
      <div className="mt-5 text-center">
        <SignOutButton className="text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:text-[#A1A1AA] dark:hover:text-[#FAFAFA]" />
      </div>
    </AuthShell>
  );
}
