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
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ClerkThemeBridge>{children}</ClerkThemeBridge>
      <Toaster
        position="bottom-right"
        toastOptions={{
          className:
            '!rounded-lg !border !border-slate-200 !bg-white !text-slate-800 !shadow-md dark:!border-slate-800 dark:!bg-slate-900 dark:!text-slate-100',
        }}
        closeButton
      />
    </ThemeProvider>
  );
}
