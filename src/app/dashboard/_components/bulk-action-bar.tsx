'use client';

import { ChevronDown, Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { Teammate } from '@/lib/teammates/queries';

import { TeammatePicker } from './teammate-picker';

/**
 * Generic multi-selection action bar. Renders only the actions wired by the
 * caller: pass `assignable` + `onAssignOwner` for the owner picker, and/or
 * `onDelete` for bulk delete. Used by the Companies and Contacts tables.
 */
export function BulkActionBar({
  count,
  pending,
  currentUserId,
  assignable,
  onAssignOwner,
  onDelete,
  onClear,
}: {
  count: number;
  pending: boolean;
  currentUserId: string;
  assignable?: Teammate[];
  onAssignOwner?: (ownerId: string | null) => void;
  onDelete?: () => void;
  onClear: () => void;
}) {
  const [ownerOpen, setOwnerOpen] = useState(false);
  const triggerCls =
    'inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60';

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[13px]">
      <span className="font-medium text-indigo-900">{count} selected</span>
      <span className="h-4 w-px bg-indigo-200" aria-hidden />

      {assignable && onAssignOwner ? (
        <div className="relative">
          <button type="button" disabled={pending} onClick={() => setOwnerOpen((v) => !v)} className={triggerCls}>
            Assign owner
            <ChevronDown className="h-3 w-3 text-slate-400" aria-hidden />
          </button>
          <TeammatePicker
            open={ownerOpen}
            onOpenChange={setOwnerOpen}
            teammates={assignable}
            currentUserId={currentUserId}
            selectedId={null}
            onSelect={(t) => {
              setOwnerOpen(false);
              onAssignOwner(t.id);
            }}
            onUnassign={() => {
              setOwnerOpen(false);
              onAssignOwner(null);
            }}
          />
        </div>
      ) : null}

      {onDelete ? (
        <button
          type="button"
          disabled={pending}
          onClick={onDelete}
          className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1 font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
          Delete
        </button>
      ) : null}

      {pending ? <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden /> : null}

      <button type="button" onClick={onClear} className="ml-auto rounded-md px-2 py-1 text-[12px] font-medium text-indigo-700 hover:bg-indigo-100">
        Clear
      </button>
    </div>
  );
}
