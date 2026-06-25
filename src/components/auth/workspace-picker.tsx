'use client';

import { setActiveTenantAction } from '@/lib/auth/actions';
import type { Workspace } from '@/lib/auth/workspaces';

export function WorkspacePicker({ workspaces }: { workspaces: Workspace[] }) {
  return (
    <ul className="space-y-2">
      {workspaces.map((ws) => (
        <li key={ws.tenantId}>
          <form action={setActiveTenantAction.bind(null, ws.tenantId)}>
            <button
              type="submit"
              className="flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-indigo-300 hover:bg-indigo-50/50 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:hover:border-indigo-700 dark:hover:bg-indigo-950/20"
            >
              <span className="text-[13.5px] font-medium text-slate-900 dark:text-[#FAFAFA]">
                {ws.name}
              </span>
              <span className="text-[11px] capitalize text-slate-400 dark:text-[#A1A1AA]">
                {ws.role}
              </span>
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
