'use client';

import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { MembershipRole } from '@/db/schema';
import { cn } from '@/lib/utils';

/**
 * Remove-member confirmation dialog. Replaces the inline "Confirm /
 * Cancel" two-button pattern with a proper modal showing the member's
 * name, role, tenant, and an impact warning. Keyboard-accessible:
 * Escape closes, focus traps to the Cancel button on open.
 *
 * Last-admin protection: if the member being removed is the only
 * admin/owner in the tenant, we surface a blocking warning instead
 * of the confirm button. The server-side action would also reject
 * the removal — this is just informative UX.
 */
type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
  memberName: string;
  memberEmail: string | null;
  memberRole: MembershipRole;
  tenantName: string;
  /** True if this would leave the tenant with zero admins/owners. */
  isLastAdmin: boolean;
};

export function RemoveMemberDialog({
  open,
  onClose,
  onConfirm,
  pending,
  memberName,
  memberEmail,
  memberRole,
  tenantName,
  isLastAdmin,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, pending]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-member-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => !pending && onClose()}
        tabIndex={-1}
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-[#1F1F1F]">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-rose-50 dark:bg-rose-500/15">
              <AlertTriangle
                className="h-4 w-4 text-rose-600 dark:text-rose-300"
                aria-hidden
              />
            </div>
            <div>
              <h2
                id="remove-member-title"
                className="text-[14px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]"
              >
                Remove member?
              </h2>
              <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
                This unassigns them from the workspace and revokes access.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !pending && onClose()}
            disabled={pending}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 dark:hover:bg-[#181818]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="px-5 py-4">
          <dl className="space-y-2 text-[12px]">
            <Row dt="Member" dd={memberName} />
            {memberEmail ? <Row dt="Email" dd={memberEmail} mono /> : null}
            <Row dt="Role" dd={roleLabel(memberRole)} />
            <Row dt="Workspace" dd={tenantName} />
          </dl>

          {isLastAdmin ? (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50/80 px-3 py-2 text-[11.5px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
              <strong className="font-semibold">Cannot remove.</strong> This
              would leave the workspace with no admin or owner. Promote
              another member first.
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[11.5px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              <strong className="font-semibold">Impact:</strong> they lose
              access to deals, contacts, and conversations in this workspace
              immediately. Their owned records stay (now unassigned).
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]/40">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex items-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#FAFAFA] dark:hover:bg-[#181818]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || isLastAdmin}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-rose-500 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2',
              (pending || isLastAdmin) && 'cursor-not-allowed opacity-60',
            )}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Remove member
          </button>
        </footer>
      </div>
    </div>
  );
}

function Row({ dt, dd, mono }: { dt: string; dd: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-20 flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
        {dt}
      </dt>
      <dd
        className={cn(
          'min-w-0 flex-1 truncate text-slate-900 dark:text-[#FAFAFA]',
          mono && 'font-mono text-[11px]',
        )}
        title={dd}
      >
        {dd}
      </dd>
    </div>
  );
}

function roleLabel(role: MembershipRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'manager':
      return 'Manager';
    case 'member':
      return 'Member';
    case 'viewer':
      return 'Viewer';
  }
}
