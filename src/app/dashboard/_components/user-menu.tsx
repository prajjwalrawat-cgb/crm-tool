'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { signOutAction } from '@/lib/auth/actions';

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase());
  return letters.join('') || '?';
}

export function UserMenu({
  displayName,
  email,
  imageUrl,
}: {
  displayName: string;
  email: string | null;
  imageUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-indigo-50 text-[11px] font-semibold text-indigo-700 transition hover:ring-2 hover:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-indigo-950/40 dark:text-indigo-300"
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
          />
        ) : (
          initialsOf(displayName)
        )}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
          <div className="border-b border-slate-100 px-3 py-2.5 dark:border-[#1F1F1F]">
            <p className="truncate text-[13px] font-medium text-slate-900 dark:text-[#FAFAFA]">
              {displayName}
            </p>
            {email ? (
              <p className="truncate text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                {email}
              </p>
            ) : null}
          </div>
          <Link
            href="/dashboard/settings/profile"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-[13px] text-slate-700 transition hover:bg-slate-50 dark:text-[#FAFAFA] dark:hover:bg-slate-800/40"
          >
            Profile settings
          </Link>
          <form action={signOutAction} className="border-t border-slate-100 dark:border-[#1F1F1F]">
            <button
              type="submit"
              className="w-full px-3 py-2 text-left text-[13px] text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
