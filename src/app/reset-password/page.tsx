import Link from 'next/link';

import { AuthShell } from '@/components/auth/auth-shell';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';

export const metadata = { title: 'Reset password' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : '';

  if (!token) {
    return (
      <AuthShell subtitle="Reset link missing or malformed.">
        <p className="text-center text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          This page needs a valid reset link.{' '}
          <Link
            href="/forgot-password"
            className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
          >
            Request a new one
          </Link>
          .
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell subtitle="Choose a new password for your account.">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
