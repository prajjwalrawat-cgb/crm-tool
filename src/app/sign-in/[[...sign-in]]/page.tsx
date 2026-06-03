import { SignIn } from '@clerk/nextjs';

import { SaleinxLogo } from '@/lib/brand/logo';
import { clerkAppearance } from '@/lib/clerk-theme';

// Clerk's <SignIn> is an entirely runtime auth widget. In Next.js 16
// the dev compiler tries to prerender catchall segments and the worker
// crashes on browser-only Clerk internals — force-dynamic skips static
// path generation for this route.
export const dynamic = 'force-dynamic';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-[26rem]">
        <header className="mb-6 flex flex-col items-center text-center">
          <SaleinxLogo size="lg" />
          <p className="mt-4 text-[13px] text-slate-500">
            Sign in to your workspace. Email and password only.
          </p>
        </header>
        <SignIn appearance={clerkAppearance} />
      </div>
    </main>
  );
}
