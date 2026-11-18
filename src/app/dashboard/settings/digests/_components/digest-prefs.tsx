'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setDigestMuteAction } from '../actions';

const ITEMS: Array<{ key: 'daily' | 'weekly' | 'all'; label: string; help: string }> = [
  { key: 'daily', label: 'Daily digest', help: 'Every day at 09:00: yesterday vs the day before, SLA breaches, stale leads, top and bottom rep.' },
  { key: 'weekly', label: 'Weekly digest', help: 'Mondays at 09:00: last week vs the week before, funnel, lead sources.' },
  { key: 'all', label: 'All report emails', help: 'Mute every scheduled report email, including saved reports.' },
];

export function DigestPrefs({ muted }: { muted: string[] }) {
  const [state, setState] = useState(new Set(muted));
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-slate-900">Report digests</h2>
        <p className="mt-0.5 text-[12.5px] text-slate-500">
          Managers get these by email, at 09:00 in the workspace timezone. Tick a box to stop getting that email.
        </p>
      </header>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {ITEMS.map((it) => (
          <li key={it.key} className="flex items-start justify-between gap-4 p-4">
            <div>
              <div className="text-[13px] font-medium text-slate-900">{it.label}</div>
              <div className="text-[12px] text-slate-500">{it.help}</div>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-slate-700">
              <input
                type="checkbox"
                checked={state.has(it.key)}
                disabled={pending}
                onChange={(e) => {
                  const v = e.target.checked;
                  setState((s) => {
                    const n = new Set(s);
                    if (v) n.add(it.key);
                    else n.delete(it.key);
                    return n;
                  });
                  start(async () => {
                    const r = await setDigestMuteAction(it.key, v);
                    if (!r.ok) toast.error('Could not save');
                  });
                }}
              />
              Muted
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
