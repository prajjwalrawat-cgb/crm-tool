'use client';

import { useActionState } from 'react';

import { createWorkspaceAction, type AuthFormState } from '@/lib/auth/actions';

import { Field, FormError, SubmitButton } from './form-bits';

export function CreateWorkspaceForm({
  hasWorkspaces,
}: {
  hasWorkspaces: boolean;
}) {
  const [state, action] = useActionState<AuthFormState, FormData>(
    createWorkspaceAction,
    {},
  );
  return (
    <div
      className={
        hasWorkspaces
          ? 'mt-5 border-t border-slate-200 pt-5 dark:border-[#1F1F1F]'
          : ''
      }
    >
      {hasWorkspaces ? (
        <p className="mb-3 text-center text-[12px] text-slate-500 dark:text-[#A1A1AA]">
          or create a new workspace
        </p>
      ) : null}
      <form action={action} className="space-y-3">
        <Field
          label="Workspace name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder="Acme Inc."
        />
        <FormError message={state.error} />
        <SubmitButton>Create workspace</SubmitButton>
      </form>
    </div>
  );
}
