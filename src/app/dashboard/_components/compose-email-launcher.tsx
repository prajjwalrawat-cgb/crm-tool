'use client';

import { Mail } from 'lucide-react';
import { useState } from 'react';

import { ComposeEmailDrawer } from './compose-email-drawer';

/**
 * Client-side launcher pair: a button that opens the compose drawer.
 * Lives outside the drawer so server components can drop it into the
 * entity header without going client themselves.
 */
export function ComposeEmailLauncher({
  entityType,
  entityId,
  entityLabel,
  defaultRecipients = [],
  canSend,
}: {
  entityType: 'deal' | 'company' | 'contact';
  entityId: string;
  entityLabel: string;
  defaultRecipients?: string[];
  canSend: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canSend) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50/40 hover:text-indigo-700"
      >
        <Mail className="h-3.5 w-3.5" aria-hidden />
        Email
      </button>
      <ComposeEmailDrawer
        open={open}
        onOpenChange={setOpen}
        entityType={entityType}
        entityId={entityId}
        entityLabel={entityLabel}
        defaultRecipients={defaultRecipients}
      />
    </>
  );
}
