'use client';

import type { ReactNode } from 'react';

import { signOutAction } from '@/lib/auth/actions';

export function SignOutButton({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <form action={signOutAction}>
      <button type="submit" className={className}>
        {children ?? 'Sign out'}
      </button>
    </form>
  );
}
