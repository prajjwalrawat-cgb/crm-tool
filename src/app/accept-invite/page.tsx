import Link from 'next/link';

import { AcceptInviteForm } from '@/components/auth/accept-invite-form';
import { AuthShell } from '@/components/auth/auth-shell';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { currentUser } from '@/lib/auth/server';
import { getInvitationByToken } from '@/lib/team/invitations';

export const metadata = { title: 'Accept invitation' };

const linkClass =
  'font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400';

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';

  const found = token ? await getInvitationByToken(token) : null;
  if (!found) {
    return (
      <AuthShell subtitle="Invitation unavailable">
        <p className="text-center text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          This invitation is invalid or has expired. Ask an admin to send a new
          one, or{' '}
          <Link href="/sign-in" className={linkClass}>
            sign in
          </Link>
          .
        </p>
      </AuthShell>
    );
  }

  const me = await currentUser();
  const myEmail = me?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;

  // Signed in as the invited address — one click to join.
  if (me && myEmail === found.invitation.email) {
    return (
      <AuthShell subtitle={`You've been invited to join “${found.tenant.name}”.`}>
        <AcceptInviteForm token={token} tenantName={found.tenant.name} />
      </AuthShell>
    );
  }

  // Signed in as a different account.
  if (me) {
    return (
      <AuthShell subtitle="This invitation is for a different account.">
        <div className="space-y-4 text-center">
          <p className="text-[13px] text-slate-500 dark:text-[#A1A1AA]">
            This invite was sent to{' '}
            <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
              {found.invitation.email}
            </span>
            , but you're signed in as{' '}
            <span className="font-medium text-slate-700 dark:text-[#FAFAFA]">
              {myEmail}
            </span>
            . Sign out and use the invited account.
          </p>
          <SignOutButton className="inline-flex w-full items-center justify-center rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:text-[#FAFAFA] dark:hover:bg-slate-800/40" />
        </div>
      </AuthShell>
    );
  }

  // Not signed in — create the account at the invited address (locked).
  return (
    <AuthShell subtitle={`Join “${found.tenant.name}” on Saleinx.`}>
      <SignUpForm
        token={token}
        lockedEmail={found.invitation.email}
        next={`/accept-invite?token=${token}`}
      />
      <p className="mt-4 text-center text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Already have an account?{' '}
        <Link
          href={`/sign-in?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`}
          className={linkClass}
        >
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
