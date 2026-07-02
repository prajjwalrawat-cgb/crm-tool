'use client';

import { Check, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { marginBpsToPct, marginMinor } from '@/lib/deals/approval';
import { formatCurrency } from '@/lib/deals/currency';
import { cn } from '@/lib/utils';

import {
  approveDealAction,
  bulkApproveDealsAction,
  bulkRejectDealsAction,
  rejectDealAction,
} from '../../actions';

type Row = {
  id: string;
  name: string;
  amountMinor: number;
  marginBps: number | null;
  currency: string;
  companyName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  ownerName: string | null;
};

export function ApprovalQueue({ rows: initial }: { rows: Row[] }) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, startBulk] = useTransition();

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function removeMany(ids: string[]) {
    const gone = new Set(ids);
    setRows((rs) => rs.filter((r) => !gone.has(r.id)));
    setSelected(new Set());
  }

  function bulkApprove() {
    if (selectedIds.length === 0) return;
    startBulk(async () => {
      const res = await bulkApproveDealsAction(selectedIds);
      if (res.ok) {
        toast.success(`Approved ${res.count} deal${res.count === 1 ? '' : 's'}`);
        removeMany(selectedIds);
      } else {
        toast.error(res.message);
      }
    });
  }

  function bulkReject() {
    if (selectedIds.length === 0) return;
    startBulk(async () => {
      const res = await bulkRejectDealsAction({ ids: selectedIds });
      if (res.ok) {
        toast.success(
          `Rejected ${res.count} deal${res.count === 1 ? '' : 's'} — reopened to Negotiation`,
        );
        removeMany(selectedIds);
      } else {
        toast.error(res.message);
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-[13px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
        🎉 Nothing awaiting approval. You&apos;re all caught up.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Bulk toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
        <label className="flex items-center gap-2 text-[12px] font-medium text-slate-600 dark:text-[#A1A1AA]">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/40"
          />
          {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={bulkApprove}
            disabled={bulkPending || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {bulkPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve selected
          </button>
          <button
            type="button"
            onClick={bulkReject}
            disabled={bulkPending || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Reject selected
          </button>
        </div>
      </div>

      <ul className="space-y-2">
        {rows.map((r) => (
          <ApprovalRow
            key={r.id}
            row={r}
            selected={selected.has(r.id)}
            onToggle={() => toggle(r.id)}
            onResolved={() => removeMany([r.id])}
            disabled={bulkPending}
          />
        ))}
      </ul>
    </div>
  );
}

function ApprovalRow({
  row,
  selected,
  onToggle,
  onResolved,
  disabled,
}: {
  row: Row;
  selected: boolean;
  onToggle: () => void;
  onResolved: () => void;
  disabled: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function approve() {
    startTransition(async () => {
      const res = await approveDealAction(row.id);
      if (res.ok) {
        toast.success(`Approved ${row.name}`);
        onResolved();
      } else {
        toast.error(res.message);
      }
    });
  }

  function reject() {
    startTransition(async () => {
      const res = await rejectDealAction({ id: row.id });
      if (res.ok) {
        toast.success(`Rejected ${row.name} — reopened to Negotiation`);
        onResolved();
      } else {
        toast.error(res.message);
      }
    });
  }

  const subtitle = [row.companyName, row.contactName ?? row.contactEmail]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white p-3 dark:bg-[#0A0A0A]',
        selected
          ? 'border-indigo-300 ring-1 ring-indigo-200 dark:border-indigo-500/50'
          : 'border-slate-200 dark:border-[#1F1F1F]',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/40"
        />
        <div className="min-w-0">
          <Link
            href={`/dashboard/deals/${row.id}`}
            className="font-medium text-slate-900 hover:underline dark:text-[#FAFAFA]"
          >
            {row.name}
          </Link>
          <div className="text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            {subtitle || '—'}
            {row.ownerName ? ` · Owner: ${row.ownerName}` : ''}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="font-mono text-sm text-slate-800 dark:text-[#FAFAFA]">
            {formatCurrency(row.amountMinor, row.currency)}
          </div>
          {row.marginBps != null ? (
            <div className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
              {marginBpsToPct(row.marginBps)}% ·{' '}
              {formatCurrency(marginMinor(row.amountMinor, row.marginBps), row.currency)}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={pending || disabled}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve
          </button>
          <button
            type="button"
            onClick={reject}
            disabled={pending || disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            Reject
          </button>
        </div>
      </div>
    </li>
  );
}
