'use client';

import { Bookmark, Plus, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * Per-user saved views for the deals list. A "view" is just the current
 * filter + search query string, named and stored in localStorage (keyed by
 * user). Click a chip to apply it; the active view is highlighted. Pagination
 * params are stripped so a view is stable regardless of where you were.
 */
type SavedView = { id: string; name: string; query: string };

const PREFIX = 'crm.deals.views.';

function normalizedQuery(params: URLSearchParams): string {
  const p = new URLSearchParams(params.toString());
  p.delete('cursor');
  p.delete('page');
  p.sort();
  return p.toString();
}

export function SavedViews({ userId }: { userId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const storageKey = PREFIX + userId;
  const [views, setViews] = useState<SavedView[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
      setViews(Array.isArray(parsed) ? parsed : []);
    } catch {
      setViews([]);
    }
  }, [storageKey]);

  function persist(next: SavedView[]) {
    setViews(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
  }

  const activeQuery = normalizedQuery(searchParams);

  function saveCurrent() {
    const name = window.prompt('Name this view (saves the current filters + search):');
    if (!name || !name.trim()) return;
    const view: SavedView = {
      id: crypto.randomUUID(),
      name: name.trim(),
      query: activeQuery,
    };
    // Replace any existing view with the same name.
    persist([...views.filter((v) => v.name !== view.name), view]);
  }

  function applyView(v: SavedView) {
    router.push(`${pathname}${v.query ? `?${v.query}` : ''}`);
  }

  function remove(id: string) {
    persist(views.filter((v) => v.id !== id));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Bookmark className="h-3 w-3" aria-hidden />
        Views
      </span>
      {views.map((v) => {
        const isActive = v.query === activeQuery;
        return (
          <span
            key={v.id}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
              isActive
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
            )}
          >
            <button type="button" onClick={() => applyView(v)} title={`Apply "${v.name}"`}>
              {v.name}
            </button>
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              onClick={() => remove(v.id)}
              className="-mr-0.5 rounded p-0.5 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={saveCurrent}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
      >
        <Plus className="h-3 w-3" aria-hidden />
        Save view
      </button>
    </div>
  );
}
