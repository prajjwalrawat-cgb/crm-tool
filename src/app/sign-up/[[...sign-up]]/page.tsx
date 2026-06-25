import { AuthShell } from '@/components/auth/auth-shell';
import { SignUpForm } from '@/components/auth/sign-up-form';

export const metadata = { title: 'Create account' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' ? sp.next : undefined;

  return (
    <AuthShell subtitle="Create your account. An admin can add you to a workspace, or you can create your own.">
      <SignUpForm next={next} />
    </AuthShell>
  );
}
