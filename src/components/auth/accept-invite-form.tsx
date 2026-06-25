'use client';

import { useActionState } from 'react';

import { acceptInviteAction, type AuthFormState } from '@/lib/auth/actions';

import { FormError, SubmitButton } from './form-bits';

export function AcceptInviteForm({
  token,
  tenantName,
}: {
  token: string;
  tenantName: string;
}) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    acceptInviteAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state.error} />
      <SubmitButton>Join {tenantName}</SubmitButton>
    </form>
  );
}
