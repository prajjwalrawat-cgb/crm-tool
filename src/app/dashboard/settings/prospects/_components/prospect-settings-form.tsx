'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { prospectSettingsError } from '@/lib/prospects/rules';
import type { ProspectSettings } from '@/lib/prospects/settings';

import { saveProspectSettings } from '../actions';

const box = 'rounded-lg border border-slate-200 p-4 dark:border-[#1F1F1F]';
const label = 'flex items-center gap-2 text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]';
const help = 'mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]';
const num = 'w-20 rounded-md border border-slate-300 px-2 py-1 text-[13px] dark:border-[#2A2A2A] dark:bg-transparent';

export function ProspectSettingsForm({ initial }: { initial: ProspectSettings }) {
  const [claimDays, setClaimDays] = useState(String(initial.claimDays));
  const [claimExpiryEnabled, setClaimExpiryEnabled] = useState(initial.claimExpiryEnabled);
  const [autoParkDays, setAutoParkDays] = useState(String(initial.autoParkDays));
  const [autoParkEnabled, setAutoParkEnabled] = useState(initial.autoParkEnabled);
  const [enrichmentEnabled, setEnrichmentEnabled] = useState(initial.enrichmentEnabled);
  const [pending, start] = useTransition();
  const router = useRouter();

  function save() {
    const input = {
      // A blank field is NaN, which fails validation like any out-of-range value.
      claimDays: claimDays.trim() === '' ? Number.NaN : Number(claimDays),
      claimExpiryEnabled,
      autoParkDays: autoParkDays.trim() === '' ? Number.NaN : Number(autoParkDays),
      autoParkEnabled,
      enrichmentEnabled,
    };
    const invalid = prospectSettingsError(input);
    if (invalid) return void toast.error(invalid);
    start(async () => {
      const r = await saveProspectSettings(input);
      if (!r.ok) return void toast.error(r.message);
      toast.success('Prospect board settings saved');
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className={box}>
        <label className={label}>
          Claim window (days)
          <input type="number" min={1} max={90} className={num} value={claimDays} disabled={pending} onChange={(e) => setClaimDays(e.target.value)} />
        </label>
        <p className={help}>How long a claim holds a prospect for its owner, from 1 to 90 days.</p>
      </div>
      <div className={box}>
        <label className={label}>
          <input type="checkbox" checked={claimExpiryEnabled} disabled={pending} onChange={(e) => setClaimExpiryEnabled(e.target.checked)} />
          Claims expire
        </label>
        <p className={help}>When off, new claims never expire. Existing claims keep their dates.</p>
      </div>
      <div className={box}>
        <label className={label}>
          Auto-park after (days idle)
          <input type="number" min={7} max={365} className={num} value={autoParkDays} disabled={pending} onChange={(e) => setAutoParkDays(e.target.value)} />
        </label>
        <p className={help}>Prospects with no activity for this long are parked, from 7 to 365 days.</p>
      </div>
      <div className={box}>
        <label className={label}>
          <input type="checkbox" checked={autoParkEnabled} disabled={pending} onChange={(e) => setAutoParkEnabled(e.target.checked)} />
          Auto-park idle prospects
        </label>
        <p className={help}>Run the daily job that moves idle prospects to Parked.</p>
      </div>
      <div className={box}>
        <label className={label}>
          <input
            type="checkbox"
            checked={enrichmentEnabled}
            disabled={pending || !initial.aiSuggestionsEnabled}
            onChange={(e) => setEnrichmentEnabled(e.target.checked)}
          />
          AI enrichment
        </label>
        <p className={help}>Suggest ICP scores and fit notes for prospects. Suggestions are reviewed by a person.</p>
        {!initial.aiSuggestionsEnabled ? (
          <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">
            Turn on AI suggestions first (saved setting: {enrichmentEnabled ? 'on' : 'off'} — takes effect when AI suggestions are turned on)
          </p>
        ) : null}
      </div>
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
