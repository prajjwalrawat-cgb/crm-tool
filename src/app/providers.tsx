'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { dark } from '@clerk/themes';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';

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
      // Light is the first-load default per CP#16C-C. System mode is
      // still available via the Appearance settings picker; returning
      // users with a saved next-themes preference keep theirs (the
      // localStorage value takes precedence over `defaultTheme`).
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <ClerkThemeBridge>{children}</ClerkThemeBridge>
      <Toaster
        position="bottom-right"
        toastOptions={{
          className:
            '!rounded-lg !border !border-slate-200 !bg-white !text-slate-800 !shadow-md dark:!border-[#1F1F1F] dark:!bg-[#0A0A0A] dark:!text-[#FAFAFA]',
        }}
        closeButton
      />
    </ThemeProvider>
  );
}
