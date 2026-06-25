'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { signUpAction, type AuthFormState } from '@/lib/auth/actions';

import { Field, FormError, SubmitButton } from './form-bits';

const linkClass =
  'text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400';

/**
 * `lockedEmail` is set when arriving from an invite link — the address is
 * fixed to the invitee and the invite `token` is carried through so the
 * new account is joined to the workspace on submit.
 */
export function SignUpForm({
  token,
  lockedEmail,
  next,
}: {
  token?: string;
  lockedEmail?: string;
  next?: string;
}) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    signUpAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" name="firstName" autoComplete="given-name" />
        <Field label="Last name" name="lastName" autoComplete="family-name" />
      </div>
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={lockedEmail}
        readOnly={Boolean(lockedEmail)}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormError message={state.error} />
      <SubmitButton>Create account</SubmitButton>
      <div className="pt-1 text-center">
        <Link
          href={next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in'}
          className={linkClass}
        >
          Already have an account? Sign in
        </Link>
      </div>
    </form>
  );
}
