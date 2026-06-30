'use client';

import {
  Briefcase,
  Building2,
  CheckSquare,
  CornerDownLeft,
  History,
  LayoutDashboard,
  Plus,
  Search,
  UsersRound,
  Workflow,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { SearchHit, SearchResponse } from '@/lib/search/types';
import { cn } from '@/lib/utils';

/**
 * Cmd/Ctrl-K global command palette.
 *
 * UX model — three modes, switched on by query length:
 *   - Empty query: shows quick actions + recent items (per-tenant
 *     localStorage). This is the "I just popped it open" state.
 *   - 1-99 chars: shows live grouped results from /api/search.
 *   - Loading: previous results stay visible to avoid layout flicker.
 *
 * Keyboard:
 *   Up/Down       move selection
 *   Enter         open the highlighted row
 *   Esc           close the palette
 *   Ctrl/Cmd+1..5 jump to a section header (deal/company/contact/wf/recent)
 *
 * The palette is rendered at the shell level so it's available on every
 * dashboard route. Search recents are keyed by tenant id so switching
 * orgs gives you a fresh history list.
 */

type Action = {
  kind: 'action';
  id: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  href: string;
};

type RecentItem = SearchHit & { ts: number };

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  deal: 'Deals',
  company: 'Companies',
  contact: 'Contacts',
  workflow: 'Workflows',
  task: 'Tasks',
};

const KIND_ICON: Record<SearchHit['kind'], ReactNode> = {
  deal: <Briefcase className="h-3.5 w-3.5 text-indigo-500" aria-hidden />,
  company: <Building2 className="h-3.5 w-3.5 text-indigo-500" aria-hidden />,
  contact: <UsersRound className="h-3.5 w-3.5 text-indigo-500" aria-hidden />,
  workflow: <Workflow className="h-3.5 w-3.5 text-indigo-500" aria-hidden />,
  task: <CheckSquare className="h-3.5 w-3.5 text-indigo-500" aria-hidden />,
};

const QUICK_ACTIONS: Action[] = [
  {
    kind: 'action',
    id: 'goto-dashboard',
    title: 'Go to Dashboard',
    icon: <LayoutDashboard className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard',
  },
  {
    kind: 'action',
    id: 'goto-workflows',
    title: 'Go to Workflows',
    icon: <Workflow className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/workflows',
  },
  {
    kind: 'action',
    id: 'goto-tasks',
    title: 'Go to Tasks',
    icon: <CheckSquare className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/tasks?assignedToMe=1',
  },
  {
    kind: 'action',
    id: 'create-deal',
    title: 'Create deal',
    hint: 'opens the new-deal form',
    icon: <Plus className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/deals?new=1',
  },
  {
    kind: 'action',
    id: 'create-company',
    title: 'Create company',
    hint: 'opens the new-company form',
    icon: <Plus className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/companies?new=1',
  },
  {
    kind: 'action',
    id: 'create-contact',
    title: 'Create contact',
    hint: 'opens the new-contact form',
    icon: <Plus className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/contacts?new=1',
  },
  {
    kind: 'action',
    id: 'create-task',
    title: 'Create task',
    hint: 'opens the tasks page',
    icon: <Plus className="h-3.5 w-3.5 text-slate-500" aria-hidden />,
    href: '/dashboard/tasks',
  },
];

const RECENT_STORAGE_PREFIX = 'crm.palette.recent.';
const MAX_RECENTS = 6;

function recentsKey(tenantId: string): string {
  return RECENT_STORAGE_PREFIX + tenantId;
}

function loadRecents(tenantId: string): RecentItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(recentsKey(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function saveRecents(tenantId: string, items: RecentItem[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      recentsKey(tenantId),
      JSON.stringify(items.slice(0, MAX_RECENTS)),
    );
  } catch {
    /* storage may be unavailable in private mode */
  }
}

export function CommandPalette({
  tenantId,
  open,
  onOpenChange,
}: {
  tenantId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state every time the palette opens; load recents on first
  // open so we don't read localStorage on every render.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setSelectedIndex(0);
    setRecents(loadRecents(tenantId));
    // Focus the input after the dialog mounts. setTimeout 0 so the
    // browser's autofocus race doesn't drop the call.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, tenantId]);

  // Debounced server search. 120ms is the sweet spot for a typeahead
  // — perceptible to the user but well below the network round-trip
  // cost of issuing one request per keystroke.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length === 0) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: ctrl.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const body = (await res.json()) as SearchResponse;
        if (body.query === term || term.includes(body.query)) {
          setHits(body.hits);
          setSelectedIndex(0);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Keep the previous result visible on transient failure rather
        // than blanking the palette.
      } finally {
        setLoading(false);
      }
    }, 120);
    return () => clearTimeout(handle);
  }, [query, open]);

  // The list of selectable rows changes between modes.
  const rows = useMemo<
    Array<{ key: string; section: string; element: ReactNode; onSelect: () => void }>
  >(() => {
    if (query.trim().length === 0) {
      const recentRows = recents.map((r, i) => ({
        key: `recent-${i}`,
        section: 'Recent',
        element: <HitRow hit={r} />,
        onSelect: () => commitOpen(r),
      }));
      const actionRows = QUICK_ACTIONS.map((a) => ({
        key: a.id,
        section: 'Quick actions',
        element: <ActionRow action={a} />,
        onSelect: () => commitAction(a),
      }));
      return [...recentRows, ...actionRows];
    }
    return hits.map((h) => ({
      key: `${h.kind}-${h.id}`,
      section: KIND_LABEL[h.kind],
      element: <HitRow hit={h} />,
      onSelect: () => commitOpen(h),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hits, recents]);

  // Clamp selection if the row count shrinks.
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= rows.length) {
      setSelectedIndex(rows.length - 1);
    }
  }, [rows.length, selectedIndex]);

  const commitOpen = useCallback(
    (hit: SearchHit) => {
      const item: RecentItem = { ...hit, ts: Date.now() };
      const next = [
        item,
        ...recents.filter(
          (r) => !(r.kind === hit.kind && r.id === hit.id),
        ),
      ].slice(0, MAX_RECENTS);
      setRecents(next);
      saveRecents(tenantId, next);
      onOpenChange(false);
      router.push(hit.href);
    },
    [recents, router, tenantId, onOpenChange],
  );

  const commitAction = useCallback(
    (action: Action) => {
      onOpenChange(false);
      router.push(action.href);
    },
    [router, onOpenChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) =>
          rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[selectedIndex];
        if (row) row.onSelect();
      }
    },
    [rows, selectedIndex, onOpenChange],
  );

  if (!open) return null;

  // Section grouping: emit a header when the section changes.
  const groupedRows: Array<{ header?: string; row: (typeof rows)[number]; absoluteIndex: number }> = [];
  let lastSection = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const headerNeeded = r.section !== lastSection;
    groupedRows.push({
      header: headerNeeded ? r.section : undefined,
      row: r,
      absoluteIndex: i,
    });
    lastSection = r.section;
  }

  const empty = query.trim().length > 0 && !loading && rows.length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]"
      />
      <div className="relative mx-4 w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
          <Search className="h-4 w-4 text-slate-400" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setQuery(e.target.value)
            }
            placeholder="Search deals, companies, contacts, workflows…"
            className="w-full bg-transparent text-[13px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 py-0 text-[10px] font-medium text-slate-500 sm:inline">
            esc
          </kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto py-1">
          {empty ? (
            <div className="px-3 py-8 text-center text-[12px] text-slate-500">
              <Search className="mx-auto mb-2 h-5 w-5 text-slate-300" aria-hidden />
              No results for <span className="font-medium text-slate-700">&ldquo;{query}&rdquo;</span>.
            </div>
          ) : groupedRows.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-slate-500">
              Type to search — or pick a quick action below.
            </div>
          ) : (
            <ul className="flex flex-col">
              {groupedRows.map(({ header, row, absoluteIndex }) => (
                <li key={row.key}>
                  {header ? (
                    <div className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.06em] text-slate-400">
                      {header === 'Recent' ? (
                        <History className="h-3 w-3" aria-hidden />
                      ) : null}
                      <span>{header}</span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onMouseEnter={() => setSelectedIndex(absoluteIndex)}
                    onClick={() => row.onSelect()}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors',
                      absoluteIndex === selectedIndex
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    {row.element}
                    {absoluteIndex === selectedIndex ? (
                      <CornerDownLeft
                        className="ml-auto h-3 w-3 text-indigo-400"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/50 px-3 py-1.5 text-[10px] text-slate-500">
          <span>
            {loading
              ? 'Searching…'
              : query.length > 0
                ? `${rows.length} result${rows.length === 1 ? '' : 's'}`
                : 'Quick actions + recent'}
          </span>
          <span className="flex items-center gap-2">
            <span>
              <kbd className="rounded border border-slate-200 bg-white px-1 py-0">↑</kbd>
              <kbd className="ml-0.5 rounded border border-slate-200 bg-white px-1 py-0">↓</kbd>{' '}
              move
            </span>
            <span>
              <kbd className="rounded border border-slate-200 bg-white px-1 py-0">↵</kbd>{' '}
              open
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function HitRow({ hit }: { hit: SearchHit }) {
  return (
    <>
      {KIND_ICON[hit.kind]}
      <span className="flex-1 truncate">
        <span className="font-medium">{hit.title}</span>
        {hit.subtitle ? (
          <span className="ml-2 text-[10.5px] text-slate-400">
            {hit.subtitle}
          </span>
        ) : null}
      </span>
      {hit.kind === 'deal' ? (
        <span className="shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-slate-500">
          {hit.stage}
        </span>
      ) : null}
      {hit.kind === 'workflow' ? (
        <span className="shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-slate-500">
          {hit.status}
        </span>
      ) : null}
      {hit.kind === 'task' ? (
        <span className="shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide text-slate-500">
          {hit.priority}
        </span>
      ) : null}
    </>
  );
}

function ActionRow({ action }: { action: Action }) {
  return (
    <>
      {action.icon}
      <span className="flex-1 truncate">
        <span className="font-medium">{action.title}</span>
        {action.hint ? (
          <span className="ml-2 text-[10.5px] text-slate-400">
            {action.hint}
          </span>
        ) : null}
      </span>
    </>
  );
}
