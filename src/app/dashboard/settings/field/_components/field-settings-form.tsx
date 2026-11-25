'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { FieldSettings } from '@/lib/field/settings';

import { saveFieldSettingsAction } from '../actions';

const box = 'rounded-lg border border-slate-200 p-4 dark:border-[#1F1F1F]';
const label = 'flex items-center gap-2 text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]';
const help = 'mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]';
const num = 'w-24 rounded-md border border-slate-300 px-2 py-1 text-[13px] dark:border-[#2A2A2A] dark:bg-transparent';

/** A blank field is NaN, which the server rejects like any out-of-range value. */
const toNum = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

export function FieldSettingsForm({ initial }: { initial: FieldSettings }) {
  const [radius, setRadius] = useState(String(initial.checkinRadiusM));
  const [grace, setGrace] = useState(String(initial.graceMin));
  const [momDue, setMomDue] = useState(String(initial.momDueHours));
  const [start, setStart] = useState(initial.trackingStart);
  const [end, setEnd] = useState(initial.trackingEnd);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function save() {
    setError(null);
    startTransition(async () => {
      const r = await saveFieldSettingsAction({
        checkinRadiusM: toNum(radius),
        graceMin: toNum(grace),
        momDueHours: toNum(momDue),
        trackingStart: start,
        trackingEnd: end,
      });
      if (!r.ok) {
        setError(r.message);
        toast.error(r.message);
        return;
      }
      toast.success('Field meeting settings saved');
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className={box}>
        <label className={label}>
          Check-in radius (m)
          <input type="number" min={50} max={5000} className={num} value={radius} disabled={pending} onChange={(e) => setRadius(e.target.value)} />
        </label>
        <p className={help}>How close a rep must be to the site to check in, from 50 to 5000 metres. A company can override this.</p>
      </div>
      <div className={box}>
        <label className={label}>
          No-check-in grace (min)
          <input type="number" min={0} max={120} className={num} value={grace} disabled={pending} onChange={(e) => setGrace(e.target.value)} />
        </label>
        <p className={help}>Minutes after the start time before a meeting with no check-in is flagged, from 0 to 120.</p>
      </div>
      <div className={box}>
        <label className={label}>
          Meeting notes due (hours)
          <input type="number" min={1} max={72} className={num} value={momDue} disabled={pending} onChange={(e) => setMomDue(e.target.value)} />
        </label>
        <p className={help}>Hours after check-out before missing notes are flagged, from 1 to 72.</p>
      </div>
      <div className={box}>
        <div className={label}>
          Tracking hours
          <input type="time" aria-label="Tracking start" className={num} value={start} disabled={pending} onChange={(e) => setStart(e.target.value)} />
          <span aria-hidden>to</span>
          <input type="time" aria-label="Tracking end" className={num} value={end} disabled={pending} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <p className={help}>Location is only recorded between these hours, in the workspace time zone. Start must be before end.</p>
      </div>
      <div className={box}>
        <label className={label}>
          Location provider
          <select
            disabled
            aria-describedby="provider-help"
            value={initial.locationProvider}
            onChange={() => {}}
            className="rounded-md border border-slate-300 px-2 py-1 text-[13px] opacity-60 dark:border-[#2A2A2A] dark:bg-transparent"
          >
            <option value="none">None</option>
            <option value="askmira">Ask Mira</option>
            <option value="native">Native app</option>
          </select>
        </label>
        <p id="provider-help" className={help}>Choosing a live location provider is available later.</p>
      </div>
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        onClick={save}
        disabled={pending}
        className="rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
