'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { Comment, MembershipRole, Prospect, ProspectStage } from '@/db/schema';
import { LOW_CONFIDENCE, type SuggestionView } from '@/lib/ai/suggestions/view';
import { promoteBlock } from '@/lib/prospects/promote/rules';
import { editBlock } from '@/lib/prospects/rules';
import { can } from '@/lib/rbac';
import type { Teammate } from '@/lib/teammates/queries';

import { CommentsThread } from '../../_components/comments-thread';
import { Drawer } from '../../_components/drawer';
import { SuggestionItem } from '../../suggestions/_components/suggestion-item';
import { ClaimPanel } from './claim-panel';
import { STAGE_LABELS } from './prospect-column';
import { PromoteDialog, type PromoteSeed } from './promote-dialog';
import { ProspectForm } from './prospect-form';
import { VoteButtons } from './vote-buttons';

export type StageHistoryEntry = {
  fromStage: ProspectStage | null;
  toStage: ProspectStage;
  changedBy: string;
  changedAt: Date;
};

type Props = {
  prospect: Prospect;
  history: StageHistoryEntry[];
  /** Pending AI suggestions on this prospect that the viewer may review. */
  suggestions: SuggestionView[];
  teammates: Teammate[];
  offerings: { id: string; name: string }[];
  sources: string[];
  role: MembershipRole;
  currentUserId: string;
  tenantId: string;
  myVotes: { knowSomeone: boolean; priority: boolean };
  /** Users the viewer may reassign claims to; null means everyone. */
  reassignScope: string[] | null;
  comments: Comment[];
  authorLookup: Record<string, string>;
  /** Real vote totals for this prospect, loaded by the page. */
  voteCounts: { knowSomeone: number; priority: number };
  /** The claim holder is within the viewer's team scope (page-computed). */
  holderInScope: boolean;
  /** From a bulk result row: expands the promote panel with that outcome, no server call. `n` re-seeds. */
  promoteSeed?: (PromoteSeed & { n: number }) | null;
  onSeedConsumed?: () => void;
  onClose: () => void;
};

const fmt = (d: Date | string) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function ProspectDrawer({
  prospect,
  history,
  suggestions,
  teammates,
  offerings,
  sources,
  role,
  currentUserId,
  tenantId,
  myVotes,
  reassignScope,
  comments,
  authorLookup,
  voteCounts,
  holderInScope,
  promoteSeed = null,
  onSeedConsumed,
  onClose,
}: Props) {
  const [now] = useState(() => Date.now());
  const [promote, setPromote] = useState<{ key: number; seed: PromoteSeed | null } | null>(null);
  const promoteOpen = promote !== null;
  const [seenN, setSeenN] = useState(0);
  if (promoteSeed && promoteSeed.n !== seenN) {
    setSeenN(promoteSeed.n);
    setPromote({ key: promoteSeed.n, seed: { kind: promoteSeed.kind, candidates: promoteSeed.candidates } });
  }
  useEffect(() => {
    if (promoteSeed) onSeedConsumed?.();
  }, [promoteSeed, onSeedConsumed]);

  const block = editBlock(prospect, { userId: currentUserId, role });
  const disabledReason =
    block === 'promoted'
      ? 'Promoted prospects are read-only.'
      : block === 'deleted'
        ? 'This prospect was deleted.'
        : block === 'no_permission'
          ? 'You have read-only access to prospects.'
          : null;
  const canPromote = can(role, 'promoteProspects');
  const promoteReason = promoteBlock(prospect, { userId: currentUserId, role }, { holderInScope }, new Date(now));
  const PROMOTE_REASONS: Record<string, string> = {
    parked: 'Unpark it first.',
    missing_contact: 'Add an email or phone before promoting.',
    promoted: 'Already promoted to a lead.',
    deleted: 'This prospect was deleted.',
    claimed_by_other: 'Claimed by someone else.',
    out_of_scope: 'That person is outside your team.',
  };
  const nameOf = (id: string | null) => {
    if (!id) return 'Unknown';
    if (id.startsWith('system:')) return 'System';
    return teammates.find((t) => t.id === id)?.displayName ?? 'Former member';
  };

  const claimActive =
    prospect.claimedBy && (!prospect.claimExpiresAt || new Date(prospect.claimExpiresAt).getTime() > now);

  return (
    <Drawer open onClose={onClose} title={prospect.companyName} description={STAGE_LABELS[prospect.stage]} widthClass="max-w-xl">
        {block === 'promoted' && prospect.promotedDealId ? (
          <p className="mb-4 rounded-md bg-indigo-50 px-3 py-2 text-[13px] text-indigo-800">
            Promoted to a lead.{' '}
            <Link href={`/dashboard/deals/${prospect.promotedDealId}`} className="font-medium underline">
              Open lead →
            </Link>
          </p>
        ) : block === 'no_permission' ? (
          <p className="mb-4 text-[12px] text-slate-500">You have read-only access to prospects.</p>
        ) : null}

        {canPromote && (promoteReason !== 'promoted' || promoteOpen) ? (
          <div className="mb-4">
            {promoteReason === 'promoted' ? null : (
              <button
                type="button"
                disabled={promoteReason !== null || promoteOpen}
                onClick={() => setPromote({ key: Date.now(), seed: null })}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
              >
                Promote to lead
              </button>
            )}
            {promoteReason && promoteReason !== 'promoted' ? (
              <p className="mt-1 text-[12px] text-slate-500">{PROMOTE_REASONS[promoteReason] ?? ''}</p>
            ) : null}
          </div>
        ) : null}
        {promoteOpen ? (
          <PromoteDialog
            key={promote.key}
            prospectId={prospect.id}
            seed={promote.seed}
            claimerName={prospect.claimedBy ? nameOf(prospect.claimedBy) : null}
            canCreateAnyway={can(role, 'manageProspectClaims') || role === 'owner' || role === 'admin'}
            onClose={() => setPromote(null)}
          />
        ) : null}

        {/* Remount when the row changes so defaults reflect the saved values. */}
        <ProspectForm
          key={`${prospect.id}:${new Date(prospect.updatedAt).getTime()}`}
          mode="edit"
          prospect={prospect}
          offerings={offerings}
          sources={sources}
          readOnly={block !== null}
          onSaved={() => undefined}
        />

        {suggestions.length > 0 ? <ProspectSuggestions suggestions={suggestions} /> : null}

        <ClaimPanel
          key={prospect.id}
          prospect={prospect}
          teammates={teammates}
          role={role}
          currentUserId={currentUserId}
          reassignScope={reassignScope}
          disabledReason={disabledReason}
        />

        <VoteButtons
          prospectId={prospect.id}
          key={`${prospect.id}:${voteCounts.knowSomeone}:${voteCounts.priority}:${myVotes.knowSomeone}:${myVotes.priority}`}
          knowSomeone={voteCounts.knowSomeone}
          priority={voteCounts.priority}
          myVotes={myVotes}
          disabledReason={disabledReason}
        />

        <div className="mt-6 border-t border-slate-200 pt-4">
          <CommentsThread
            tenantId={tenantId}
            entityType="prospect"
            entityId={prospect.id}
            currentUserId={currentUserId}
            initialComments={comments}
            authorLookup={authorLookup}
            teammates={teammates}
            canWrite={block === null}
          />
        </div>

        <section className="mt-6 border-t border-slate-200 pt-4 text-[13px] text-slate-700">
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Details</h3>
          <dl className="space-y-1">
            <div className="flex gap-2">
              <dt className="w-24 text-slate-500">Created</dt>
              <dd>
                {nameOf(prospect.createdBy)}, {fmt(prospect.createdAt)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 text-slate-500">Claim</dt>
              <dd>
                {claimActive
                  ? `Claimed by ${nameOf(prospect.claimedBy)}${prospect.claimExpiresAt ? ` until ${fmt(prospect.claimExpiresAt)}` : ''}`
                  : 'Unclaimed'}
              </dd>
            </div>
          </dl>

          <h3 className="mb-2 mt-4 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Stage history</h3>
          {history.length === 0 ? (
            <p className="text-slate-500">No stage changes yet.</p>
          ) : (
            <ul className="space-y-1">
              {history.map((h, i) => (
                <li key={i}>
                  {h.fromStage ? `${STAGE_LABELS[h.fromStage]} → ` : 'Created in '}
                  {STAGE_LABELS[h.toStage]}
                  <span className="text-slate-500">
                    {' '}
                    by {nameOf(h.changedBy)}, {fmt(h.changedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
    </Drawer>
  );
}

/**
 * "AI suggestions" for the open prospect: enrichment proposals, each with
 * Accept / Edit / Reject (the review queue's own item and actions). Accepting
 * goes through updateProspect as this user, so a read-only prospect refuses.
 */
function ProspectSuggestions({ suggestions }: { suggestions: SuggestionView[] }) {
  const strong = suggestions.filter((v) => v.confidence >= LOW_CONFIDENCE);
  const weak = suggestions.filter((v) => v.confidence < LOW_CONFIDENCE);
  return (
    <section className="mt-6 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3" aria-labelledby="prospect-ai-suggestions-h">
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden />
        <h3 id="prospect-ai-suggestions-h" className="text-[13px] font-semibold text-slate-900">
          AI suggestions
        </h3>
        <span className="rounded-full bg-indigo-100 px-1.5 text-[11px] font-medium text-indigo-700">{suggestions.length}</span>
        <Link href="/dashboard/suggestions" className="ml-auto text-[11px] text-indigo-600 hover:underline">
          Review queue
        </Link>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">Nothing changes until you accept.</p>
      <ul className="space-y-2">
        {strong.map((s) => (
          <SuggestionItem key={s.id} s={s} />
        ))}
      </ul>
      {weak.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-slate-500 hover:text-slate-800">
            {weak.length} low-confidence suggestion{weak.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 space-y-2">
            {weak.map((s) => (
              <SuggestionItem key={s.id} s={s} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
