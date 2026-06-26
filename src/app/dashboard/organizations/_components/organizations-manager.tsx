'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Workspace } from '@/lib/auth/workspaces';

import {
  deleteWorkspaceAction,
  getWorkspaceStatsAction,
  renameWorkspaceAction,
  type WorkspaceStats,
} from '../actions';

const inputCls =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

export function OrganizationsManager({
  owned,
  activeTenantId,
}: {
  owned: Workspace[];
  activeTenantId: string;
}) {
  const initial =
    owned.find((w) => w.tenantId === activeTenantId)?.tenantId ??
    owned[0]?.tenantId ??
    '';
  const [selectedId, setSelectedId] = useState(initial);

  if (owned.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-[13px] text-slate-500">
        You don't own any workspaces.
      </p>
    );
  }

  const selected =
    owned.find((w) => w.tenantId === selectedId) ?? owned[0]!;

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-slate-600">
          Select workspace
        </span>
        <select
          value={selected.tenantId}
          onChange={(e) => setSelectedId(e.target.value)}
          className={inputCls}
        >
          {owned.map((ws) => (
            <option key={ws.tenantId} value={ws.tenantId}>
              {ws.name}
              {ws.tenantId === activeTenantId ? ' (active)' : ''}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[11px] text-slate-400">
          You own {owned.length} workspace{owned.length === 1 ? '' : 's'}.
        </span>
      </label>

      {/* Keyed by id so switching workspaces resets the edit/confirm state. */}
      <OrgCard
        key={selected.tenantId}
        ws={selected}
        active={selected.tenantId === activeTenantId}
      />
    </div>
  );
}

function OrgCard({ ws, active }: { ws: Workspace; active: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [saving, startSave] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  function openConfirm() {
    setConfirmOpen(true);
    setStats(null);
    setLoadingStats(true);
    getWorkspaceStatsAction(ws.tenantId)
      .then(setStats)
      .finally(() => setLoadingStats(false));
  }

  function save() {
    startSave(async () => {
      const res = await renameWorkspaceAction(ws.tenantId, name);
      if (res.ok) {
        toast.success('Workspace renamed');
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove() {
    startDelete(async () => {
      const res = await deleteWorkspaceAction(ws.tenantId);
      // On an active-workspace delete the action redirects (no return value).
      if (res?.ok === false) {
        toast.error(res.error);
      } else {
        toast.success('Workspace deleted');
        router.refresh();
      }
    });
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-slate-900">
          {ws.name}
          {active ? (
            <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
              Active
            </span>
          ) : null}
        </h2>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-400">slug: {ws.slug}</p>

      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[12px] font-medium text-slate-600">
            Workspace name
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </label>
        <button
          type="button"
          onClick={save}
          disabled={saving || name.trim() === ws.name || name.trim().length < 2}
          className="inline-flex h-[38px] items-center gap-2 rounded-lg bg-indigo-600 px-3 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Save
        </button>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        {!confirmOpen ? (
          <button
            type="button"
            onClick={openConfirm}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-rose-600 hover:text-rose-700"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete workspace
          </button>
        ) : (
          <div className="space-y-2 rounded-md border border-rose-200 bg-rose-50/60 p-3">
            <p className="text-[12px] text-rose-700">
              This permanently deletes <strong>{ws.name}</strong> and everything in
              it. This cannot be undone.
            </p>

            <div className="rounded-md border border-rose-200 bg-white/70 px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-rose-500">
                What will be removed
              </p>
              {loadingStats ? (
                <p className="flex items-center gap-1.5 text-[12px] text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Counting…
                </p>
              ) : stats ? (
                <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12px] text-slate-700">
                  <Stat label="Deals" value={stats.deals} />
                  <Stat label="Contacts" value={stats.contacts} />
                  <Stat label="Companies" value={stats.companies} />
                  <Stat label="Invoices" value={stats.invoices} />
                  <Stat label="Tasks" value={stats.tasks} />
                  <Stat label="Members" value={stats.members} />
                </ul>
              ) : (
                <p className="text-[12px] text-slate-500">
                  All deals, contacts, companies, invoices, tasks, and members.
                </p>
              )}
            </div>

            <p className="text-[12px] text-rose-700">
              Type <strong>{ws.name}</strong> to confirm.
            </p>
            <div className="flex items-center gap-2">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={ws.name}
                className={inputCls}
              />
              <button
                type="button"
                onClick={remove}
                disabled={deleting || confirmText !== ws.name}
                className="inline-flex h-[38px] shrink-0 items-center gap-2 rounded-lg bg-rose-600 px-3 text-[13px] font-medium text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  setConfirmText('');
                }}
                className="h-[38px] shrink-0 rounded-lg border border-slate-200 px-3 text-[13px] font-medium text-slate-700 hover:bg-white"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums text-slate-900">{value}</span>
    </li>
  );
}
