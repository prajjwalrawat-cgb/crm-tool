import { AuthShell } from '@/components/auth/auth-shell';
import { FormNote } from '@/components/auth/form-bits';
import { SignInForm } from '@/components/auth/sign-in-form';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === 'string' ? sp.next : undefined;

  return (
    <AuthShell subtitle="Sign in to your workspace. Email and password only.">
      {sp.reset ? (
        <div className="mb-4">
          <FormNote>
            Your password was updated. Sign in with your new password.
          </FormNote>
        </div>
      ) : null}
      <SignInForm next={next} />
    </AuthShell>
  );
}
