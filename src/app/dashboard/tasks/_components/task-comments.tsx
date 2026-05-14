'use client';

import { Loader2, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import type { TaskComment } from '@/db/schema';
import type { Teammate } from '@/lib/teammates/queries';
import { RelativeTime } from '@/lib/dates/relative-time';
import { cn } from '@/lib/utils';

import {
  createTaskCommentAction,
  deleteTaskCommentAction,
} from '../comments-actions';

/**
 * Comment thread embedded in the task detail drawer. Loads initial
 * comments server-side from the parent (Task detail page passes them
 * in) and stays interactive via optimistic-on-create + revalidate.
 *
 * Author-only delete. Edit deferred to v2 — author can delete then
 * repost in v1 if they need to correct something.
 */
export function TaskComments({
  taskId,
  initialComments,
  teammates,
  currentUserId,
}: {
  taskId: string;
  initialComments: TaskComment[];
  teammates: Teammate[];
  currentUserId: string;
}) {
  const [comments, setComments] = useState<TaskComment[]>(initialComments);
  const [body, setBody] = useState('');
  const [pending, start] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Resync when the parent task changes (drawer reopens on a different task).
  useEffect(() => {
    setComments(initialComments);
  }, [initialComments]);

  const teammateById = new Map(teammates.map((t) => [t.id, t]));

  function submit() {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;

    // Optimistic insert with a temp id so the thread updates immediately.
    const tempId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: TaskComment = {
      id: tempId,
      tenantId: '',
      taskId,
      authorUserId: currentUserId,
      body: trimmed,
      editedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setComments((prev) => [...prev, optimistic]);
    setBody('');

    start(async () => {
      const result = await createTaskCommentAction({ taskId, body: trimmed });
      if (!result.ok) {
        setComments((prev) => prev.filter((c) => c.id !== tempId));
        setBody(trimmed);
        toast.error(result.message);
        return;
      }
      // Replace the optimistic row with the real one.
      setComments((prev) =>
        prev.map((c) => (c.id === tempId ? result.comment : c)),
      );
    });
  }

  function remove(id: string) {
    if (id.startsWith('optimistic-')) return;
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Delete this comment?')
    ) {
      return;
    }
    const snapshot = comments;
    setComments((prev) => prev.filter((c) => c.id !== id));
    start(async () => {
      const result = await deleteTaskCommentAction(id);
      if (!result.ok) {
        setComments(snapshot);
        toast.error(result.message);
      }
    });
  }

  function authorName(id: string): string {
    const m = teammateById.get(id);
    return m?.displayName ?? id;
  }
  function authorInitial(id: string): string {
    return (authorName(id)[0] ?? '?').toUpperCase();
  }

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        <MessageSquare className="h-3 w-3" aria-hidden />
        Comments
        {comments.length > 0 ? (
          <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
            {comments.length}
          </span>
        ) : null}
      </h3>

      {comments.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3 text-[12px] text-slate-500">
          No comments yet. Start the discussion below.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => {
            const mine = c.authorUserId === currentUserId;
            const isOptimistic = c.id.startsWith('optimistic-');
            const teammate = teammateById.get(c.authorUserId);
            return (
              <li
                key={c.id}
                className={cn(
                  'group flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[12.5px]',
                  isOptimistic && 'opacity-70',
                )}
              >
                {teammate?.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={teammate.imageUrl}
                    alt=""
                    className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover ring-1 ring-slate-200"
                  />
                ) : (
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-700 ring-1 ring-slate-200">
                    {authorInitial(c.authorUserId)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-slate-800">
                      {authorName(c.authorUserId)}
                    </span>
                    <span className="shrink-0 cursor-default text-[10px] tabular-nums text-slate-400">
                      <RelativeTime date={c.createdAt} />
                      {c.editedAt ? ' · edited' : null}
                    </span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-slate-700">
                    {c.body}
                  </p>
                </div>
                {mine && !isOptimistic ? (
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    aria-label="Delete comment"
                    className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={4000}
          placeholder="Add a comment… (⌘⏎ to post)"
          rows={2}
          className="w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-[12.5px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        />
        <div className="flex items-center justify-end gap-2">
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />
          ) : null}
          <button
            type="button"
            onClick={submit}
            disabled={pending || body.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Post
          </button>
        </div>
      </div>
    </section>
  );
}
