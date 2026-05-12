'use client';

import { Loader2, UserCircle2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Teammate } from '@/lib/teammates/queries';

import { TeammatePicker } from '../../../_components/teammate-picker';
import { updateDealOwnerAction } from '../../actions';

/**
 * Owner card on the deal detail sidebar. Renders the current owner's
 * name + avatar; clicking opens the searchable teammate picker. The
 * picker pulls from the local memberships table (real Clerk users)
 * plus the seeded persona pool on Test 1, so the demo tenant has a
 * believable team to assign to.
 */
export function DealOwnerPicker({
  dealId,
  currentOwnerId,
  currentOwnerName,
  currentUserId,
  teammates,
  canEdit,
}: {
  dealId: string;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
  currentUserId: string;
  teammates: Teammate[];
  canEdit: boolean;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(currentOwnerId);
  const [ownerName, setOwnerName] = useState<string | null>(currentOwnerName);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const ownerTeammate = teammates.find((t) => t.id === ownerId);
  const display = ownerTeammate?.displayName ?? ownerName ?? null;

  function commit(nextOwnerId: string | null, nextOwnerName: string | null) {
    const previousId = ownerId;
    const previousName = ownerName;
    setOwnerId(nextOwnerId);
    setOwnerName(nextOwnerName);
    setOpen(false);
    startTransition(async () => {
      const result = await updateDealOwnerAction({
        id: dealId,
        ownerId: nextOwnerId,
      });
      if (!result.ok) {
        setOwnerId(previousId);
        setOwnerName(previousName);
        toast.error(result.message);
      } else if (result.changed) {
        toast.success('Owner updated');
      }
    });
  }

  return (
    <div className="relative rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          Owner
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
          >
            {ownerId ? 'Reassign' : 'Assign'}
          </button>
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2">
        <OwnerAvatar teammate={ownerTeammate ?? null} fallbackId={ownerId} />
        <span className="truncate text-sm text-slate-800">
          {display ?? 'Unassigned'}
        </span>
        {pending ? (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-slate-400"
            aria-hidden
          />
        ) : null}
      </div>

      <TeammatePicker
        open={open}
        onOpenChange={setOpen}
        teammates={teammates}
        currentUserId={currentUserId}
        selectedId={ownerId}
        onSelect={(t) => commit(t.id, t.displayName)}
        onUnassign={() => commit(null, null)}
      />
    </div>
  );
}

function OwnerAvatar({
  teammate,
  fallbackId,
}: {
  teammate: Teammate | null;
  fallbackId: string | null;
}) {
  if (!teammate && !fallbackId) {
    return (
      <UserCircle2 className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
    );
  }
  if (teammate?.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={teammate.imageUrl}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  }
  const name = teammate?.displayName ?? fallbackId ?? '?';
  const initials = name
    .split(/\s+|-/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
      {initials || '?'}
    </span>
  );
}
