import type { ReactNode } from 'react';

import { getCurrentMembership } from '@/lib/membership';
import { personaOf } from '@/lib/personas';

import { SettingsNav } from './_components/settings-nav';

export const metadata = {
  title: 'Settings',
};

/**
 * Settings shell — fixed left rail of section links plus a content
 * pane on the right. The rail is sticky on tall content so the user
 * never loses the section context as they scroll.
 *
 * Per-section persona visibility (settings-nav.tsx is the source of
 * truth):
 *   - everyone           profile, appearance, notifications
 *   - manager + admin    organization, pipeline, currency
 *   - admin only         email, AI infrastructure
 *
 * Page-level `requirePersonas()` guards are still authoritative —
 * this just hides links that would 403.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const membership = await getCurrentMembership();
  const persona = personaOf(membership?.role ?? null);
  return (
    <main className="mx-auto w-full max-w-[80rem] px-4 py-6 sm:px-5 lg:px-6">
      <header className="mb-5 border-b border-slate-200 pb-4 dark:border-[#1F1F1F]">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
          Settings
        </h1>
        <p className="mt-1 text-[13px] text-slate-500 dark:text-[#A1A1AA]">
          Manage your profile, appearance, notifications, and workspace
          preferences.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <SettingsNav persona={persona} />
        </aside>
        <section>{children}</section>
      </div>
    </main>
  );
}
