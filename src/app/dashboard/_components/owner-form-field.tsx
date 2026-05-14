'use client';

import { UserCircle2 } from 'lucide-react';
import { useState } from 'react';

import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

import { TeammatePicker } from './teammate-picker';

/**
 * Owner picker designed for create / edit forms. Renders a button +
 * popover that drives a hidden `<input name="ownerId">`, so it
 * round-trips through `<form action={...}>` exactly like any native
 * field. Posts an empty string when unassigned — the server action
 * normalizes that to null.
 */
export function OwnerFormField({
  name = 'ownerId',
  label = 'Owner',
  teammates,
  currentUserId,
  defaultOwnerId = null,
  errors,
  required,
  hint,
}: {
  name?: string;
  label?: string;
  teammates: Teammate[];
  currentUserId: string;
  defaultOwnerId?: string | null;
  errors?: string[];
  required?: boolean;
  hint?: string;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(defaultOwnerId);
  const [open, setOpen] = useState(false);

  const selected = teammates.find((t) => t.id === ownerId) ?? null;
  const hasError = Boolean(errors?.length);

  return (
    <div className="relative flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-700">
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <input type="hidden" name={name} value={ownerId ?? ''} />

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center justify-between gap-2 rounded-md border bg-white px-3 py-1.5 text-left text-sm shadow-sm transition',
          'hover:border-slate-300 focus:outline-none focus:ring-2',
          hasError
            ? 'border-red-300 focus:border-red-500 focus:ring-red-500/20'
            : 'border-slate-200 focus:border-indigo-500 focus:ring-indigo-500/20',
        )}
      >
        <span className="flex items-center gap-2 truncate text-slate-800">
          <OwnerSwatch teammate={selected} />
          <span className="truncate">
            {selected?.displayName ?? (
              <span className="text-slate-400">Unassigned</span>
            )}
          </span>
        </span>
        <span className="text-[11px] font-medium text-indigo-600">
          {selected ? 'Change' : 'Assign'}
        </span>
      </button>

      <TeammatePicker
        open={open}
        onOpenChange={setOpen}
        teammates={teammates}
        currentUserId={currentUserId}
        selectedId={ownerId}
        onSelect={(t) => {
          setOwnerId(t.id);
          setOpen(false);
        }}
        onUnassign={() => {
          setOwnerId(null);
          setOpen(false);
        }}
      />

      {hint ? <p className="text-[11px] text-slate-500">{hint}</p> : null}
      {hasError ? (
        <p className="text-xs text-red-600">{errors!.join(' ')}</p>
      ) : null}
    </div>
  );
}

function OwnerSwatch({ teammate }: { teammate: Teammate | null }) {
  if (!teammate) {
    return <UserCircle2 className="h-4 w-4 text-slate-400" aria-hidden />;
  }
  if (teammate.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={teammate.imageUrl}
        alt=""
        className="h-5 w-5 rounded-full object-cover"
      />
    );
  }
  const initials =
    teammate.displayName
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
      {initials}
    </span>
  );
}
