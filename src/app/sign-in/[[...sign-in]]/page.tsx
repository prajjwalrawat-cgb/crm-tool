import { SignIn } from '@clerk/nextjs';

import { clerkAppearance } from '@/lib/clerk-theme';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-[26rem]">
        <header className="mb-6 text-center">
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">
            Sign in to your CRM
          </h1>
          <p className="mt-1 text-[13px] text-slate-500">
            Email and password only. No third-party providers.
          </p>
        </header>
        <SignIn appearance={clerkAppearance} />
      </div>
    </main>
  );
}
