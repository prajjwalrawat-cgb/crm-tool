import Link from 'next/link';

import { AuthShell } from '@/components/auth/auth-shell';
import { SignUpForm } from '@/components/auth/sign-up-form';
import { getInvitationByToken } from '@/lib/team/invitations';

export const metadata = { title: 'Create account' };

const linkClass =
  'font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; token?: string }>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' ? sp.next : undefined;
  const token = typeof sp.token === 'string' ? sp.token : '';

  // Invite-only: an account can only be created from a valid invitation link.
  const invite = token ? await getInvitationByToken(token) : null;

  if (!invite) {
    return (
      <AuthShell subtitle="Creating an account is invite-only.">
        <p className="text-center text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          Ask a workspace admin to send you an invitation. If you already have
          an account,{' '}
          <Link href="/sign-in" className={linkClass}>
            sign in
          </Link>
          .
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle={`Join “${invite.tenant.name}” on Saleinx.`}>
      <SignUpForm
        token={token}
        lockedEmail={invite.invitation.email}
        next={next ?? `/accept-invite?token=${token}`}
      />
    </AuthShell>
  );
}
