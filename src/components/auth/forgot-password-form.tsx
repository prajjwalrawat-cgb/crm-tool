'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import {
  requestPasswordResetAction,
  type AuthFormState,
} from '@/lib/auth/actions';

import { Field, FormError, FormNote, SubmitButton } from './form-bits';

const linkClass =
  'text-[12px] font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400';

export function ForgotPasswordForm() {
  const [state, action] = useActionState<AuthFormState, FormData>(
    requestPasswordResetAction,
    {},
  );

  if (state.sent) {
    return (
      <div className="space-y-4">
        <FormNote>
          If an account exists for that email, a reset link is on its way.
          Check your inbox (and spam) — the link is valid for one hour.
        </FormNote>
        <div className="text-center">
          <Link href="/sign-in" className={linkClass}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <FormError message={state.error} />
      <SubmitButton>Send reset link</SubmitButton>
      <div className="text-center">
        <Link href="/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
