'use client';

import { useState, useTransition } from 'react';

import { cn } from '@/lib/utils';

import { toggleVoteAction } from '../actions';

type Props = {
  prospectId: string;
  knowSomeone: number;
  priority: number;
  myVotes: { knowSomeone: boolean; priority: boolean };
  /** Reason text when voting is unavailable; null when allowed. */
  disabledReason: string | null;
};

export function VoteButtons({ prospectId, knowSomeone, priority, myVotes, disabledReason }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(kind: 'know_someone' | 'priority') {
    setError(null);
    startTransition(async () => {
      const r = await toggleVoteAction(prospectId, kind);
      if (!r.ok) setError(r.message);
    });
  }

  const btn = (active: boolean) =>
    cn(
      'rounded-md border px-3 py-1 text-[13px] font-medium disabled:opacity-50',
      active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 bg-white text-slate-700',
    );

  return (
    <section className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Votes</h3>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={myVotes.knowSomeone}
          disabled={pending || !!disabledReason}
          onClick={() => toggle('know_someone')}
          className={btn(myVotes.knowSomeone)}
        >
          I know someone ({knowSomeone})
        </button>
        <button
          type="button"
          aria-pressed={myVotes.priority}
          disabled={pending || !!disabledReason}
          onClick={() => toggle('priority')}
          className={btn(myVotes.priority)}
        >
          Priority ({priority})
        </button>
      </div>
      {disabledReason ? <p className="mt-1 text-[12px] text-slate-500">{disabledReason}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-[12px] text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
