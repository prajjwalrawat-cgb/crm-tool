'use client';

import { Loader2, UserCircle2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { updateDealOwnerAction } from '../../actions';

/**
 * Compact owner display + reassignment control for the deal detail
 * sidebar. Two modes:
 *   - read: shows the current owner's display name (or "Unassigned")
 *   - edit: text input that accepts an owner id (Clerk user id or
 *     `seed-actor-*` id for the demo tenant). Optimistic UI: the
 *     visible name updates immediately and rolls back on failure.
 *
 * A richer "pick from teammates" dropdown lives on the roadmap — for
 * now we accept a raw id so the primitive is unblocked.
 */
export function DealOwnerPicker({
  dealId,
  currentOwnerId,
  currentOwnerName,
  currentUserId,
  canEdit,
}: {
  dealId: string;
  currentOwnerId: string | null;
  currentOwnerName: string | null;
  currentUserId: string;
  canEdit: boolean;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(currentOwnerId);
  const [ownerName, setOwnerName] = useState<string | null>(currentOwnerName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentOwnerId ?? '');
  const [pending, startTransition] = useTransition();

  function commit(nextOwnerId: string | null, nextOwnerName: string | null) {
    const previousId = ownerId;
    const previousName = ownerName;
    setOwnerId(nextOwnerId);
    setOwnerName(nextOwnerName);
    setEditing(false);
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
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          Owner
        </div>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(ownerId ?? '');
              setEditing(true);
            }}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500"
          >
            {ownerId ? 'Reassign' : 'Assign'}
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="user id or seed-actor-…"
            className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1 text-[12px] focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = draft.trim();
                commit(v.length > 0 ? v : null, v.length > 0 ? v : null);
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              setDraft(currentUserId);
              commit(currentUserId, 'You');
            }}
            className="rounded px-1.5 py-1 text-[10.5px] text-slate-600 hover:bg-slate-100"
            title="Assign to me"
          >
            Me
          </button>
          {ownerId ? (
            <button
              type="button"
              onClick={() => commit(null, null)}
              className="rounded px-1.5 py-1 text-[10.5px] text-rose-600 hover:bg-rose-50"
            >
              Unassign
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded px-1.5 py-1 text-[10.5px] text-slate-500 hover:bg-slate-100"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <UserCircle2
            className="h-4 w-4 shrink-0 text-slate-400"
            aria-hidden
          />
          <span className="truncate text-sm text-slate-800">
            {ownerName ?? (ownerId ? ownerId : 'Unassigned')}
          </span>
          {pending ? (
            <Loader2
              className="h-3 w-3 shrink-0 animate-spin text-slate-400"
              aria-hidden
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
