import Link from 'next/link';

import { withTenantSession } from '@/lib/auth-guard';
import { listSuggestions, suggestionScope } from '@/lib/ai/suggestions/service';
import { toSuggestionView } from '@/lib/ai/suggestions/view';
import { requireMembership } from '@/lib/membership';

import { SuggestionQueue } from './_components/suggestion-queue';

export const metadata = { title: 'AI suggestions' };

type Props = { searchParams: Promise<{ view?: string }> };

/**
 * Review queue. Default: suggestions on records the viewer owns. Managers
 * (and admins) can switch to "My team", which uses the reporting-line scope
 * (reports_to subtree; admins see the workspace).
 */
export default async function SuggestionsPage({ searchParams }: Props) {
  const sp = await searchParams;
  return await withTenantSession(async ({ tenant, userId }) => {
    const m = await requireMembership();
    const canTeam = m.role === 'manager' || m.role === 'admin' || m.role === 'owner';
    const team = canTeam && sp.view === 'team';
    const scope = await suggestionScope(tenant.id, { userId, role: m.role }, { mineOnly: !team });
    const rows = await listSuggestions({ scope, limit: 200 });
    const tab = (active: boolean) =>
      `rounded-md px-2.5 py-1 text-[12px] font-medium ${active ? 'bg-slate-900 text-white dark:bg-white dark:text-black' : 'text-slate-600 hover:bg-slate-100 dark:text-[#A1A1AA] dark:hover:bg-[#181818]'}`;
    return (
      <main className="mx-auto w-full max-w-[60rem] space-y-4 px-4 py-6 sm:px-5 lg:px-6">
        <header className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">AI suggestions</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Changes the AI proposed from calls, emails and prospect research. Nothing is applied until someone accepts it, and
              accepted changes follow the same rules as editing the record yourself.
            </p>
          </div>
          {canTeam ? (
            <nav className="ml-auto flex gap-1" aria-label="Queue">
              <Link href="/dashboard/suggestions" className={tab(!team)}>
                Mine
              </Link>
              <Link href="/dashboard/suggestions?view=team" className={tab(team)}>
                My team
              </Link>
            </nav>
          ) : null}
        </header>
        <SuggestionQueue items={rows.map(toSuggestionView)} />
      </main>
    );
  });
}
