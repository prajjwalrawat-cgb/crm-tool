import type { ReactNode } from 'react';

import { SaleinxLogo } from '@/lib/brand/logo';

/**
 * Centered card chrome shared by every unauthenticated page (sign-in,
 * sign-up, password reset, accept-invite).
 */
export function AuthShell({
  subtitle,
  children,
}: {
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12 dark:bg-black">
      <div className="w-full max-w-[26rem]">
        <header className="mb-6 flex flex-col items-center text-center">
          <SaleinxLogo size="lg" />
          {subtitle ? (
            <p className="mt-4 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              {subtitle}
            </p>
          ) : null}
        </header>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-100/60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:shadow-none">
          {children}
        </div>
      </div>
    </main>
  );
}
