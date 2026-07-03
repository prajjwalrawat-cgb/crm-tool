'use client';

import { Check, ChevronsUpDown, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

import { setActiveTenantAction } from '@/lib/auth/actions';

export type WorkspaceLite = { tenantId: string; name: string };

/**
 * One workspace row. Lives inside its own <form> so `useFormStatus` reflects
 * only THIS workspace's switch — showing a spinner on the row you clicked while
 * the server action redirects.
 */
function WorkspaceRow({
  name,
  isCurrent,
}: {
  name: string;
  isCurrent: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 transition hover:bg-slate-50 disabled:opacity-70 dark:text-[#FAFAFA] dark:hover:bg-slate-800/40"
    >
      <span className="truncate">{name}</span>
      {pending ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500 dark:text-indigo-400"
          aria-hidden
        />
      ) : isCurrent ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
      ) : null}
    </button>
  );
}

export function WorkspaceSwitcher({
  currentTenantId,
  currentTenantName,
  workspaces,
  canCreate,
}: {
  currentTenantId: string;
  currentTenantName: string;
  workspaces: WorkspaceLite[];
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] font-medium text-slate-700 transition hover:bg-slate-50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-slate-800/40"
      >
        <span className="max-w-[10rem] truncate">{currentTenantName}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-60 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-[#A1A1AA]">
            Workspaces
          </p>
          {workspaces.map((ws) => (
            <form
              key={ws.tenantId}
              action={setActiveTenantAction.bind(null, ws.tenantId)}
            >
              <WorkspaceRow
                name={ws.name}
                isCurrent={ws.tenantId === currentTenantId}
              />
            </form>
          ))}
          {canCreate ? (
            <>
              <div className="my-1 border-t border-slate-100 dark:border-[#1F1F1F]" />
              <Link
                href="/select-org"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-700 transition hover:bg-slate-50 dark:text-[#FAFAFA] dark:hover:bg-slate-800/40"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Create workspace
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
