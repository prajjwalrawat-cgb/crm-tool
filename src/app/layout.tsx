import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    template: '%s · Saleinx',
    default: 'Saleinx',
  },
  description:
    'Saleinx — operational CRM with built-in analytics, automation, and team collaboration.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // suppressHydrationWarning is required by next-themes; it adds a `class`
      // attribute to <html> on mount and would otherwise mismatch SSR markup.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900 dark:bg-black dark:text-[#FAFAFA]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
