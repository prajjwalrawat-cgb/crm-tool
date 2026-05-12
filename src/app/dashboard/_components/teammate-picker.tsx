'use client';

import { Check, Search, UserMinus, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

/**
 * Searchable popover for picking a teammate by name or email. Used by
 * the deal owner control today; the same component will back the
 * task assignee picker next.
 *
 * Keyboard:
 *   ↑/↓     move highlight
 *   Enter   select highlighted
 *   Esc     close
 *   /       focus the input (when popover is open)
 *
 * Selecting a teammate calls `onSelect(id, displayName)`. The
 * `Assign to me` and `Unassign` actions are surfaced as dedicated
 * footer buttons so they're always one click away regardless of how
 * many teammates there are to scroll through.
 */
export function TeammatePicker({
  open,
  onOpenChange,
  teammates,
  currentUserId,
  selectedId,
  onSelect,
  onUnassign,
  allowUnassign = true,
  anchor = 'left',
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  teammates: Teammate[];
  currentUserId: string;
  selectedId: string | null;
  onSelect: (teammate: Teammate) => void;
  onUnassign?: () => void;
  allowUnassign?: boolean;
  anchor?: 'left' | 'right';
}) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return teammates;
    return teammates.filter(
      (t) =>
        t.displayName.toLowerCase().includes(q) ||
        (t.email ?? '').toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q),
    );
  }, [teammates, query]);

  // Reset query + highlight every time we re-open and focus input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlighted(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onOpenChange(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onOpenChange(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  const handleListKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlighted((i) =>
          filtered.length === 0 ? 0 : (i + 1) % filtered.length,
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlighted((i) =>
          filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
        );
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = filtered[highlighted];
        if (t) onSelect(t);
      }
    },
    [filtered, highlighted, onSelect],
  );

  if (!open) return null;

  const me = teammates.find((t) => t.id === currentUserId);

  return (
    <div
      ref={containerRef}
      onKeyDown={handleListKey}
      className={cn(
        'absolute top-[calc(100%+4px)] z-40 w-[18rem] overflow-hidden rounded-md border border-slate-200 bg-white shadow-md',
        anchor === 'right' ? 'right-0' : 'left-0',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-slate-100 px-2 py-1.5">
        <Search className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlighted(0);
          }}
          placeholder="Search teammates…"
          className="w-full bg-transparent text-[12.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>

      <div className="max-h-[16rem] overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-slate-500">
            No teammates match.
          </p>
        ) : (
          <ul>
            {filtered.map((t, i) => {
              const isSelected = t.id === selectedId;
              const isHighlighted = i === highlighted;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => onSelect(t)}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12.5px] transition-colors',
                      isHighlighted
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-700 hover:bg-slate-50',
                    )}
                  >
                    <Avatar teammate={t} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{t.displayName}</div>
                      {t.email ? (
                        <div className="truncate text-[10.5px] text-slate-500">
                          {t.email}
                        </div>
                      ) : null}
                    </div>
                    {isSelected ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-hidden />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/40 px-2 py-1.5">
        {me ? (
          <button
            type="button"
            onClick={() => onSelect(me)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-indigo-600 hover:bg-indigo-50"
          >
            Assign to me
          </button>
        ) : (
          <span />
        )}
        {allowUnassign && onUnassign ? (
          <button
            type="button"
            onClick={onUnassign}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-50"
          >
            <UserMinus className="h-3 w-3" aria-hidden />
            Unassign
          </button>
        ) : null}
      </footer>
    </div>
  );
}

function Avatar({ teammate }: { teammate: Teammate }) {
  const initials = teammate.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  if (teammate.imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={teammate.imageUrl}
        alt=""
        className="h-5 w-5 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
      {initials || '?'}
    </span>
  );
}
