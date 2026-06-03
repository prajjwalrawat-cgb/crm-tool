import { SignUp } from '@clerk/nextjs';

import { SaleinxLogo } from '@/lib/brand/logo';
import { clerkAppearance } from '@/lib/clerk-theme';

// See sign-in page — same Clerk catchall / Next.js 16 prerender
// crash. Force-dynamic skips static path generation.
export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-[26rem]">
        <header className="mb-6 flex flex-col items-center text-center">
          <SaleinxLogo size="lg" />
          <p className="mt-4 text-[13px] text-slate-500">
            Create your account. An admin can add you to a workspace next.
          </p>
        </header>
        <SignUp appearance={clerkAppearance} />
      </div>
    </main>
  );
}
