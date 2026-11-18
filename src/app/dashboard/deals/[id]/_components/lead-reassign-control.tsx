'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { reassignLeadAction } from '../../../leads/actions';

/** Manager reassign: releases the open assignment and starts a fresh SLA for the new owner. */
export function LeadReassignControl({ dealId, people }: { dealId: string; people: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 text-[11.5px] font-medium text-indigo-600 hover:text-indigo-500">
        Reassign lead
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-1.5">
      <select
        aria-label="Reassign to"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] dark:border-[#2A2A2A] dark:bg-[#111111]"
      >
        <option value="">Reassign to…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Reason"
        placeholder="Reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] dark:border-[#2A2A2A] dark:bg-[#111111]"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!to || pending}
          onClick={() =>
            startTransition(async () => {
              const r = await reassignLeadAction(dealId, to, reason.trim() || null);
              if (!r.ok) return void toast.error(r.message);
              toast.success('Lead reassigned');
              setOpen(false);
              router.refresh();
            })
          }
          className="rounded-md bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-60"
        >
          Reassign
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-slate-600">
          Cancel
        </button>
      </div>
    </div>
  );
}
