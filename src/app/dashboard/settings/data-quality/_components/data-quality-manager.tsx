'use client';

import { ArrowRight, Loader2, Merge } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { DuplicatePair } from '@/lib/dedup/queries';
import { cn } from '@/lib/utils';

import { mergeCompaniesAction, mergeContactsAction } from '../actions';

const REASON_LABEL: Record<DuplicatePair['reason'], string> = {
  same_name: 'Identical name',
  same_email: 'Identical email',
  similar_name: 'Similar name',
};

export function DataQualityManager({
  enabled,
  companyPairs,
  contactPairs,
}: {
  enabled: boolean;
  companyPairs: DuplicatePair[];
  contactPairs: DuplicatePair[];
}) {
  if (!enabled) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-[12px] text-slate-600 dark:border-[#262626] dark:bg-[#0F0F0F] dark:text-[#A1A1AA]">
        Duplicate detection isn&apos;t enabled for this workspace. An admin can
        turn on the Dedup feature flag.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Section
        title="Companies"
        pairs={companyPairs}
        kind="company"
        empty="No candidate duplicate companies found."
      />
      <Section
        title="Contacts"
        pairs={contactPairs}
        kind="contact"
        empty="No candidate duplicate contacts found."
      />
    </div>
  );
}

function Section({
  title,
  pairs,
  kind,
  empty,
}: {
  title: string;
  pairs: DuplicatePair[];
  kind: 'company' | 'contact';
  empty: string;
}) {
  return (
    <section>
      <h2 className="mb-2 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
        {title}
        <span className="ml-2 text-[11px] font-normal text-slate-400">
          {pairs.length} candidate pair{pairs.length === 1 ? '' : 's'}
        </span>
      </h2>
      {pairs.length === 0 ? (
        <p className="text-[12px] text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {pairs.map((p) => (
            <PairRow key={`${p.a.id}-${p.b.id}`} pair={p} kind={kind} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PairRow({
  pair,
  kind,
}: {
  pair: DuplicatePair;
  kind: 'company' | 'contact';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [merged, setMerged] = useState(false);

  function merge(winnerId: string, loserId: string) {
    startTransition(async () => {
      const action = kind === 'company' ? mergeCompaniesAction : mergeContactsAction;
      const res = await action({ winnerId, loserId });
      if (!res.ok) {
        toast.error(res.message);
      } else {
        const total = Object.values(res.repointed).reduce((s, n) => s + n, 0);
        toast.success(`Merged — ${total} record(s) repointed.`);
        setMerged(true);
        router.refresh();
      }
    });
  }

  if (merged) return null;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="mb-2 flex items-center gap-2 text-[11px]">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 dark:bg-[#1F1F1F] dark:text-[#A1A1AA]">
          {REASON_LABEL[pair.reason]}
        </span>
        <span className="text-slate-400">
          {Math.round(pair.similarity * 100)}% similar
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Candidate label={pair.a.label} sublabel={pair.a.sublabel} />
        <ArrowRight className="hidden h-4 w-4 shrink-0 text-slate-300 sm:block" />
        <Candidate label={pair.b.label} sublabel={pair.b.sublabel} />
        <div className="flex gap-1.5 sm:ml-auto">
          <MergeButton
            label={`Keep “${truncate(pair.a.label)}”`}
            pending={pending}
            onClick={() => merge(pair.a.id, pair.b.id)}
          />
          <MergeButton
            label={`Keep “${truncate(pair.b.label)}”`}
            pending={pending}
            onClick={() => merge(pair.b.id, pair.a.id)}
          />
        </div>
      </div>
    </li>
  );
}

function Candidate({
  label,
  sublabel,
}: {
  label: string;
  sublabel: string | null;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-md border border-slate-100 px-2.5 py-1.5 dark:border-[#1F1F1F]">
      <div className="truncate text-[13px] font-medium text-slate-800 dark:text-[#E4E4E7]">
        {label}
      </div>
      {sublabel ? (
        <div className="truncate text-[11px] text-slate-400">{sublabel}</div>
      ) : null}
    </div>
  );
}

function MergeButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-[#333] dark:text-[#D4D4D8] dark:hover:bg-[#161616]',
      )}
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Merge className="h-3 w-3" />
      )}
      {label}
    </button>
  );
}

function truncate(s: string, n = 18): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
