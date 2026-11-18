'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setAiSuggestionsEnabled } from '../actions';

export function SuggestionsToggle({ initial, claudeConfigured }: { initial: boolean; claudeConfigured: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-[#1F1F1F]">
      <label className="flex items-center gap-2 text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]">
        <input
          type="checkbox"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            start(async () => {
              const r = await setAiSuggestionsEnabled(next);
              if (!r.ok) return void toast.error(r.message);
              setOn(next);
              toast.success(next ? 'AI suggestions on' : 'AI suggestions off');
              router.refresh();
            });
          }}
        />
        Suggest deal and contact updates from calls and emails
      </label>
      <p className="mt-1 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
        Sends call transcripts and email thread text, with the linked deal&apos;s and contact&apos;s current field values, to
        Anthropic (Claude). The AI only proposes changes; a person accepts or rejects each one. Off by default.
      </p>
      {!claudeConfigured ? (
        <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">ANTHROPIC_API_KEY is not set on the server, so nothing will be suggested yet.</p>
      ) : null}
    </div>
  );
}
