'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { dark } from '@clerk/themes';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';

function ClerkThemeBridge({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <ClerkProvider
      appearance={{
        baseTheme: resolvedTheme === 'dark' ? dark : undefined,
        variables: {
          colorPrimary: '#6366f1',
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      // The product is light-only for now. We use `forcedTheme` (not
      // just `defaultTheme`) so the html `class="dark"` is NEVER applied,
      // even for users whose localStorage still carries an old "dark"
      // preference from when this provider was on `defaultTheme="system"`.
      // `defaultTheme` alone only affects fresh visitors with empty
      // storage; `forcedTheme` overrides everyone, which is what we
      // need to truly migrate the product off dark-first.
      //
      // The `dark:*` Tailwind variants on every component remain in
      // place — drop `forcedTheme` and switch to `defaultTheme="light"`
      // when you want to re-enable a dark toggle.
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <ClerkThemeBridge>{children}</ClerkThemeBridge>
    </ThemeProvider>
  );
}
