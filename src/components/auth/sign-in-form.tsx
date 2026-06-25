'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { signInAction, type AuthFormState } from '@/lib/auth/actions';

import { Field, FormError, SubmitButton } from './form-bits';

const linkClass =
  'text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400';

export function SignInForm({ next }: { next?: string }) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    signInAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <FormError message={state.error} />
      <SubmitButton>Sign in</SubmitButton>
      <div className="flex items-center justify-between pt-1">
        <Link href="/forgot-password" className={linkClass}>
          Forgot password?
        </Link>
        <Link
          href={next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up'}
          className={linkClass}
        >
          Create account
        </Link>
      </div>
    </form>
  );
}
