'use client';

import { useActionState } from 'react';

import { resetPasswordAction, type AuthFormState } from '@/lib/auth/actions';

import { Field, FormError, SubmitButton } from './form-bits';

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    resetPasswordAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
      <FormError message={state.error} />
      <SubmitButton>Set new password</SubmitButton>
    </form>
  );
}
