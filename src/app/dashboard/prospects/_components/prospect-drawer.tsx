'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { MembershipRole, Prospect, ProspectStage } from '@/db/schema';
import { editBlock } from '@/lib/prospects/rules';
import type { Teammate } from '@/lib/teammates/queries';

import { STAGE_LABELS } from './prospect-column';
import { ProspectForm } from './prospect-form';

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
  onClose,
}: Props) {
  const [now] = useState(() => now);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const block = editBlock(prospect, { userId: currentUserId, role });
  const nameOf = (id: string | null) => {
    if (!id) return 'Unknown';
    if (id.startsWith('system:')) return 'System';
    return teammates.find((t) => t.id === id)?.displayName ?? 'Former member';
  };

  const claimActive =
    prospect.claimedBy && (!prospect.claimExpiresAt || new Date(prospect.claimExpiresAt).getTime() > now);

  return (
    <div role="dialog" aria-modal="true" aria-label={prospect.companyName} className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close drawer" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/30" />
      <aside className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white p-5 shadow-xl">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-slate-900">{prospect.companyName}</h2>
            <p className="text-[12px] text-slate-500">{STAGE_LABELS[prospect.stage]}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-2 py-1 text-[13px] text-slate-600 hover:bg-slate-50"
          >
            Close
          </button>
        </header>

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
      </aside>
    </div>
  );
}
