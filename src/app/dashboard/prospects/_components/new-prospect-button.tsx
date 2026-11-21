'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ProspectForm } from './prospect-form';

type Props = {
  offerings: { id: string; name: string }[];
  sourceTags: string[];
};

export function NewProspectButton({ offerings, sourceTags }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-700"
      >
        New prospect
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="New prospect"
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-12"
        >
          <button
            type="button"
            aria-label="Close dialog"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="mb-4 text-[15px] font-semibold text-slate-900">New prospect</h2>
            <ProspectForm
              mode="create"
              offerings={offerings}
              sourceTags={sourceTags}
              onCancel={() => setOpen(false)}
              onSaved={() => {
                setOpen(false);
                router.refresh();
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
