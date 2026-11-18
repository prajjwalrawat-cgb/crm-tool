'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { createCallCampaign } from '../../actions';

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'hold'] as const;
const input = 'w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] dark:border-[#1F1F1F] dark:bg-black';

export function CreateCampaignForm({ agents, sources }: { agents: Array<{ id: string; name: string }>; sources: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [f, setF] = useState({
    name: '',
    mode: 'preview' as 'preview' | 'progressive',
    stages: ['lead'] as string[],
    leadSourceIds: [] as string[],
    createdAfter: '',
    agentIds: [] as string[],
    start: '09:00',
    end: '21:00',
    maxAttempts: 3,
    retryGapMinutes: 120,
  });
  const toggle = (k: 'stages' | 'agentIds' | 'leadSourceIds', v: string) =>
    setF((p) => ({ ...p, [k]: p[k].includes(v) ? p[k].filter((x) => x !== v) : [...p[k], v] }));

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">New campaign</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          Name
          <input className={input} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Q4 furnace enquiries" />
        </label>
        <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          Mode
          <select className={input} value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as 'preview' | 'progressive' })}>
            <option value="preview">Preview — agent sees the lead, presses Call</option>
            <option value="progressive">Progressive — next call starts after each disposition</option>
          </select>
        </label>
        <fieldset className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          <legend>Stages</legend>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {STAGES.map((s) => (
              <label key={s} className="flex items-center gap-1 capitalize">
                <input type="checkbox" checked={f.stages.includes(s)} onChange={() => toggle('stages', s)} /> {s}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
          Created after (optional)
          <input type="date" className={input} value={f.createdAfter} onChange={(e) => setF({ ...f, createdAfter: e.target.value })} />
        </label>
        {sources.length ? (
          <fieldset className="text-[12px] text-slate-600 sm:col-span-2 dark:text-[#A1A1AA]">
            <legend>Lead sources (none = all)</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {sources.map((s) => (
                <label key={s.id} className="flex items-center gap-1">
                  <input type="checkbox" checked={f.leadSourceIds.includes(s.id)} onChange={() => toggle('leadSourceIds', s.id)} /> {s.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <fieldset className="text-[12px] text-slate-600 sm:col-span-2 dark:text-[#A1A1AA]">
          <legend>Agents</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {agents.map((a) => (
              <label key={a.id} className="flex items-center gap-1">
                <input type="checkbox" checked={f.agentIds.includes(a.id)} onChange={() => toggle('agentIds', a.id)} /> {a.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Calling from (IST)
            <input type="time" className={input} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Until
            <input type="time" className={input} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Max attempts
            <input type="number" min={1} max={20} className={input} value={f.maxAttempts} onChange={(e) => setF({ ...f, maxAttempts: Number(e.target.value) })} />
          </label>
          <label className="text-[12px] text-slate-600 dark:text-[#A1A1AA]">
            Retry gap (minutes)
            <input type="number" min={0} className={input} value={f.retryGapMinutes} onChange={(e) => setF({ ...f, retryGapMinutes: Number(e.target.value) })} />
          </label>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={pending || !f.name || f.agentIds.length === 0}
          onClick={() =>
            startTransition(async () => {
              const r = await createCallCampaign({
                name: f.name,
                mode: f.mode,
                stages: f.stages,
                ownerIds: [],
                leadSourceIds: f.leadSourceIds,
                createdAfter: f.createdAfter ? new Date(`${f.createdAfter}T00:00:00+05:30`).toISOString() : null,
                agentIds: f.agentIds,
                callingHours: { tz: 'Asia/Kolkata', start: f.start, end: f.end },
                maxAttempts: f.maxAttempts,
                retryGapMinutes: f.retryGapMinutes,
              });
              if (!r.ok) return void toast.error(r.message);
              toast.success('Campaign created as a draft — start it from its board');
              router.push(`/dashboard/telephony/campaigns/${r.id}`);
            })
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          Create campaign
        </button>
      </div>
    </section>
  );
}
