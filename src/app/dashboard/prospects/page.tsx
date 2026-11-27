import { listSuggestions } from '@/lib/ai/suggestions/service';
import { toSuggestionView } from '@/lib/ai/suggestions/view';
import { withTenantSession } from '@/lib/auth-guard';
import { listCommentsForEntity } from '@/lib/comments/queries';
import { requireMembership } from '@/lib/membership';
import { isOfferingsEnabled, listOfferingOptions } from '@/lib/offerings/queries';
import {
  getProspect,
  getVoteCounts,
  listMyVotes,
  listProspectsForBoard,
  listProspectStageHistory,
  listSourceTags,
} from '@/lib/prospects/queries';
import { parseProspectFilters, sourceChoices } from '@/lib/prospects/rules';
import { getProspectSettings } from '@/lib/prospects/settings';
import { scopeUsers } from '@/lib/reports/manager/scope';
import { listTeammates } from '@/lib/teammates/queries';

import { resolveAuthorLookup } from '../_components/author-lookup';
import { ProspectBoard } from './_components/prospect-board';

export const metadata = {
  title: 'Prospect board',
};

// Page-level maxDuration also sets the timeout of every Server Action used on this
// page (Next docs: route-segment-config/maxDuration), which covers bulk promote of
// up to 100 prospects.
export const maxDuration = 300;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProspectsPage({ searchParams }: { searchParams: SearchParams }) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const membership = await requireMembership();
    const sp = await searchParams;
    const filters = parseProspectFilters(sp);
    const p = Array.isArray(sp.p) ? sp.p[0] : sp.p;
    // Product fit follows the workspace "Offerings" switch, like deals do.
    const offeringsOn = await isOfferingsEnabled(tenant.id);
    if (!offeringsOn && filters.groupBy === 'product_fit') delete filters.groupBy;
    const [{ cards: rawCards, truncated }, usedSources, { sources }, teammates, offerings, openProspect, openHistory] = await Promise.all([
      listProspectsForBoard(tenant.id, userId, filters),
      listSourceTags(tenant.id),
      getProspectSettings(tenant.id),
      listTeammates(tenant.id, tenant.name),
      offeringsOn ? listOfferingOptions(tenant.id, { activeOnly: true }) : Promise.resolve([]),
      p ? getProspect(tenant.id, p) : Promise.resolve(null),
      p ? listProspectStageHistory(tenant.id, p) : Promise.resolve([]),
    ]);

    const cards = offeringsOn ? rawCards : rawCards.map((c) => ({ ...c, productFitOfferingId: null, productFitName: null }));
    // The workspace's sources first, then any older ones still on prospects so they stay filterable.
    const sourceTags = sourceChoices(sources, usedSources);

    // Only after the prospect is known to exist (getProspect UUID-guards `p`).
    const scopeP = openProspect ? scopeUsers({ tenantId: tenant.id, userId, role: membership.role }) : null;
    const [openComments, myVotes, voteCounts, scope, openSuggestions] = openProspect && scopeP
      ? await Promise.all([
          listCommentsForEntity(tenant.id, 'prospect', openProspect.id, { limit: 200 }),
          listMyVotes(tenant.id, userId, openProspect.id),
          getVoteCounts(tenant.id, openProspect.id),
          scopeP,
          // Pending AI suggestions on this prospect the viewer may review (same scope as the queue).
          scopeP.then((sc) =>
            listSuggestions({ scope: { tenantId: tenant.id, userIds: sc.userIds }, entity: { type: 'prospect', ids: [openProspect.id] }, limit: 50 }),
          ),
        ])
      : [[], { knowSomeone: false, priority: false }, { knowSomeone: 0, priority: 0 }, null, []];

    // Same rule as promoteProspect: only a manager's team scope can exclude the holder.
    const holderInScope =
      !openProspect?.claimedBy || !scope || scope.userIds === null || scope.userIds.includes(openProspect.claimedBy);

    const authorIds = new Set<string>();
    for (const c of openComments) {
      authorIds.add(c.authorUserId);
      for (const m of c.mentionedUserIds) authorIds.add(m);
    }
    const authorLookup = await resolveAuthorLookup([...authorIds]);

    return (
      <main className="flex min-h-[calc(100vh-3.5rem)] flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Prospect board</h1>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {tenant.name} — research prospects and drag them across stages.
          </p>
        </header>

        <ProspectBoard
          cards={cards}
          truncated={truncated}
          filters={filters}
          sourceTags={sourceTags}
          sources={sources}
          teammates={teammates}
          offerings={offerings.map((o) => ({ id: o.id, name: o.name }))}
          role={membership.role}
          currentUserId={userId}
          tenantId={tenant.id}
          reassignScope={scope ? scope.userIds : null}
          voteCounts={voteCounts}
          myVotes={myVotes}
          openComments={openComments}
          authorLookup={authorLookup}
          openProspect={openProspect}
          openHistory={openHistory}
          openSuggestions={openSuggestions.map((r) => toSuggestionView(r))}
          holderInScope={holderInScope}
        />
      </main>
    );
  });
}
