'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Comment, MembershipRole, Prospect, ProspectStage } from '@/db/schema';
import { editBlock } from '@/lib/prospects/rules';
import type { Teammate } from '@/lib/teammates/queries';

import { CommentsThread } from '../../_components/comments-thread';
import { Drawer } from '../../_components/drawer';
import { ClaimPanel } from './claim-panel';
import { STAGE_LABELS } from './prospect-column';
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
  teammates: Teammate[];
  offerings: { id: string; name: string }[];
  sourceTags: string[];
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
  onClose: () => void;
};

const fmt = (d: Date | string) => new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function ProspectDrawer({
  prospect,
  history,
  teammates,
  offerings,
  sourceTags,
  role,
  currentUserId,
  tenantId,
  myVotes,
  reassignScope,
  comments,
  authorLookup,
  voteCounts,
  onClose,
}: Props) {
  const [now] = useState(() => Date.now());

  const block = editBlock(prospect, { userId: currentUserId, role });
  const disabledReason =
    block === 'promoted'
      ? 'Promoted prospects are read-only.'
      : block === 'deleted'
        ? 'This prospect was deleted.'
        : block === 'no_permission'
          ? 'You have read-only access to prospects.'
          : null;
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

        {/* Remount when the row changes so defaults reflect the saved values. */}
        <ProspectForm
          key={`${prospect.id}:${new Date(prospect.updatedAt).getTime()}`}
          mode="edit"
          prospect={prospect}
          offerings={offerings}
          sourceTags={sourceTags}
          readOnly={block !== null}
          onSaved={() => undefined}
        />

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
