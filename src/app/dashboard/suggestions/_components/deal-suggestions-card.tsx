import 'server-only';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';

import { listSuggestions, suggestionScope } from '@/lib/ai/suggestions/service';
import { LOW_CONFIDENCE, toSuggestionView } from '@/lib/ai/suggestions/view';
import { runWithTenantContext } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';

import { SuggestionItem } from './suggestion-item';

/**
 * "AI suggestions" on the deal page: pending suggestions for this deal and its
 * contact that the viewer may review. Renders nothing when there are none.
 * Low-confidence items sit in a collapsed section.
 */
export async function DealSuggestionsCard({
  tenantId,
  userId,
  dealId,
  contactId,
}: {
  tenantId: string;
  userId: string;
  dealId: string;
  contactId: string | null;
}) {
  const membership = await requireMembership();
  const rows = await runWithTenantContext({ tenantId, userId }, async () => {
    const scope = await suggestionScope(tenantId, { userId, role: membership.role });
    const [forDeal, forContact] = await Promise.all([
      listSuggestions({ scope, entity: { type: 'deal', ids: [dealId] }, limit: 50 }),
      contactId ? listSuggestions({ scope, entity: { type: 'contact', ids: [contactId] }, limit: 50 }) : Promise.resolve([]),
    ]);
    return [...forDeal, ...forContact];
  });
  if (rows.length === 0) return null;
  const views = rows.map(toSuggestionView);
  const strong = views.filter((v) => v.confidence >= LOW_CONFIDENCE);
  const weak = views.filter((v) => v.confidence < LOW_CONFIDENCE);
  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5" aria-labelledby="ai-suggestions-h">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden />
        <h2 id="ai-suggestions-h" className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
          AI suggestions
        </h2>
        <span className="rounded-full bg-indigo-100 px-1.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200">{views.length}</span>
        <Link href="/dashboard/suggestions" className="ml-auto text-[11px] text-indigo-600 hover:underline dark:text-indigo-300">
          Review queue
        </Link>
      </div>
      <p className="mb-2 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
        Proposed from calls and emails. Nothing changes until you accept; accepted changes go through the normal deal rules.
      </p>
      <ul className="space-y-2">
        {strong.map((s) => (
          <SuggestionItem key={s.id} s={s} showEntity={s.entityType === 'contact'} />
        ))}
      </ul>
      {weak.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-slate-500 hover:text-slate-800">
            {weak.length} low-confidence suggestion{weak.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-2">
            {weak.map((s) => (
              <SuggestionItem key={s.id} s={s} showEntity={s.entityType === 'contact'} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
