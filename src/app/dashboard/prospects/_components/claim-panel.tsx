'use client';

import { useState, useTransition } from 'react';

import type { MembershipRole, Prospect } from '@/db/schema';
import { isClaimActive } from '@/lib/prospects/rules';
import { can } from '@/lib/rbac';
import type { Teammate } from '@/lib/teammates/queries';

import { TeammatePicker } from '../../_components/teammate-picker';
import { claimProspectAction, reassignClaimAction, releaseProspectAction } from '../actions';
import { daysLeft } from './prospect-card';

type Props = {
  prospect: Prospect;
  teammates: Teammate[];
  role: MembershipRole;
  currentUserId: string;
  /** Users the viewer may reassign to; null means everyone. */
  reassignScope: string[] | null;
  /** Reason text when the prospect is read-only; null when editable. */
  disabledReason: string | null;
};

const btn =
  'rounded-md border border-slate-300 bg-white px-3 py-1 text-[13px] font-medium text-slate-700 disabled:opacity-50';

export function ClaimPanel({ prospect, teammates, role, currentUserId, reassignScope, disabledReason }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [now] = useState(() => Date.now());

  const active = isClaimActive(prospect, new Date(now));
  const mine = active && prospect.claimedBy === currentUserId;
  const left = daysLeft(prospect.claimExpiresAt, now);
  const claimer = prospect.claimedBy ? teammates.find((t) => t.id === prospect.claimedBy) : null;

  const canClaim = can(role, 'claimProspects');
  const isManager = can(role, 'manageProspectClaims');
  const canRelease = active && (mine || isManager) && canClaim;
  const candidates = teammates.filter(
    (t) => (!reassignScope || reassignScope.includes(t.id)) && (t.role === null || can(t.role, 'claimProspects')),
  );

  function run(fn: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.message ?? 'Something went wrong.');
    });
  }

  const status = active
    ? `Claimed by ${mine ? 'you' : (claimer?.displayName ?? 'a former member')}${left !== null ? ` · ${left} ${left === 1 ? 'day' : 'days'} left` : ''}`
    : 'Unclaimed';
  const blocked = pending || !!disabledReason;

  return (
    <section className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Claim</h3>
      <p className="text-[13px] text-slate-800">{status}</p>
      <div className="relative mt-2 flex flex-wrap gap-2">
        {canClaim && (!active || mine) ? (
          <button type="button" disabled={blocked} onClick={() => run(() => claimProspectAction(prospect.id))} className={btn}>
            {mine ? 'Extend' : 'Claim'}
          </button>
        ) : null}
        {canRelease ? (
          <button type="button" disabled={blocked} onClick={() => run(() => releaseProspectAction(prospect.id))} className={btn}>
            Release
          </button>
        ) : null}
        {isManager ? (
          <>
            <button type="button" disabled={blocked} onClick={() => setPickerOpen((v) => !v)} className={btn}>
              Reassign…
            </button>
            <TeammatePicker
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              teammates={candidates}
              currentUserId={currentUserId}
              selectedId={active ? prospect.claimedBy : null}
              allowUnassign={false}
              onSelect={(t) => {
                setPickerOpen(false);
                run(() => reassignClaimAction(prospect.id, t.id));
              }}
            />
          </>
        ) : null}
      </div>
      {disabledReason ? <p className="mt-1 text-[12px] text-slate-500">{disabledReason}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
