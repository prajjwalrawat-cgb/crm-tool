'use client';

import { Loader2, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { Note } from '@/db/schema';
import {
  createNoteAction,
  deleteNoteAction,
  updateNoteAction,
} from '@/app/dashboard/notes/actions';
import { cn } from '@/lib/utils';

type NoteEntityType = 'deal' | 'company' | 'contact';

type NoteRow = Note & {
  authorDisplayName?: string | null;
  __pending?: boolean;
};

export function NotesTimeline({
  entityType,
  entityId,
  currentUserId,
  initialNotes,
  authorLookup,
  canWrite,
}: {
  entityType: NoteEntityType;
  entityId: string;
  currentUserId: string;
  initialNotes: Note[];
  /** Map of authorUserId → friendly display name (Clerk users + seeded). */
  authorLookup: Record<string, string>;
  canWrite: boolean;
}) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const optimistic: NoteRow = {
      id: `optimistic-${crypto.randomUUID()}`,
      tenantId: '',
      body,
      authorUserId: currentUserId,
      entityType,
      entityId,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedBy: null,
      __pending: true,
    };
    setNotes((prev) => [optimistic, ...prev]);
    setDraft('');
    startTransition(async () => {
      const result = await createNoteAction({ body, entityType, entityId });
      if (!result.ok) {
        setNotes((prev) => prev.filter((n) => n.id !== optimistic.id));
        toast.error(result.message);
      } else {
        setNotes((prev) =>
          prev.map((n) => (n.id === optimistic.id ? result.note : n)),
        );
      }
    });
  }

  function handleSaveEdit(id: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) {
      setEditing(null);
      return;
    }
    setNotes((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, body: trimmed, __pending: true } : n,
      ),
    );
    setEditing(null);
    startTransition(async () => {
      const result = await updateNoteAction({ id, body: trimmed });
      if (!result.ok) {
        toast.error(result.message);
      } else {
        setNotes((prev) =>
          prev.map((n) =>
            n.id === id ? { ...result.note, __pending: false } : n,
          ),
        );
      }
    });
  }

  function handleDelete(id: string) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    startTransition(async () => {
      const result = await deleteNoteAction(id);
      if (!result.ok) toast.error(result.message);
    });
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <MessageSquarePlus
            className="h-3.5 w-3.5 text-indigo-500"
            aria-hidden
          />
          <h2 className="text-[13px] font-semibold text-slate-900">Notes</h2>
        </div>
        <span className="text-[10px] tabular-nums text-slate-400">
          {notes.length}
        </span>
      </header>

      {canWrite ? (
        <form onSubmit={handleCreate} className="mb-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note — context, next steps, intel from a call…"
            rows={2}
            className="w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {pending ? (
              <Loader2
                className="h-3 w-3 animate-spin text-slate-400"
                aria-hidden
              />
            ) : null}
            <button
              type="submit"
              disabled={!draft.trim() || pending}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Add note
            </button>
          </div>
        </form>
      ) : null}

      {notes.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-[12px] text-slate-500">
          No notes yet. Use this space to capture call notes, intel from
          meetings, or the next-step plan.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {notes.map((note) => {
            const author =
              authorLookup[note.authorUserId] ??
              (note.authorUserId === currentUserId ? 'You' : 'Teammate');
            const editable =
              canWrite &&
              note.authorUserId === currentUserId &&
              !note.id.startsWith('optimistic-');
            const isEditing = editing?.id === note.id;
            return (
              <li
                key={note.id}
                className={cn(
                  'group rounded-md border border-slate-100 bg-slate-50/50 px-3 py-2 transition',
                  note.__pending && 'opacity-60',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-medium text-slate-800">
                    {author}
                  </span>
                  <span className="text-[10px] tabular-nums text-slate-400">
                    {relTime(new Date(note.createdAt))}
                  </span>
                </div>
                {isEditing ? (
                  <InlineEditor
                    initial={editing.body}
                    onSave={(body) => handleSaveEdit(note.id, body)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">
                      {note.body}
                    </p>
                    {editable ? (
                      <div className="mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({ id: note.id, body: note.body })
                          }
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Pencil className="h-3 w-3" aria-hidden />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(note.id)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden />
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function InlineEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  return (
    <div className="mt-1">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave(body);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full resize-y rounded border border-slate-200 bg-white px-2 py-1.5 text-[13px] focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px]">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-3 w-3" aria-hidden />
          Cancel <span className="text-slate-400">(esc)</span>
        </button>
        <button
          type="button"
          onClick={() => onSave(body)}
          className="rounded bg-indigo-600 px-2 py-0.5 font-medium text-white hover:bg-indigo-500"
        >
          Save <span className="text-indigo-200">(⌘⏎)</span>
        </button>
      </div>
    </div>
  );
}

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
