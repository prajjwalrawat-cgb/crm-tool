'use client';

import { CornerDownRight, Loader2, MessageCircle, Pencil, Reply, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { toast } from 'sonner';

import {
  createCommentAction,
  deleteCommentAction,
  updateCommentAction,
} from '@/app/dashboard/comments/actions';
import type { Comment } from '@/db/schema';
import { useRealtimeEvents } from '@/hooks/use-realtime-events';
import {
  formatMentionToken,
  parseMentions,
} from '@/lib/comments/mentions';
import type { Teammate } from '@/lib/teammates/queries';
import { cn } from '@/lib/utils';

type CommentItem = Comment & { __pending?: boolean };

type EntityType = 'deal' | 'company' | 'contact';

/**
 * Threaded comments panel attached to an entity. One level of replies
 * supported — beyond that the server normalizes child→grandchild
 * relationships back to the top-level ancestor.
 *
 * `@` triggers an inline teammate picker; selecting inserts the
 * markdown-style mention token (`@[Name](id)`) into the textarea and
 * dispatches notifications server-side on submit.
 *
 * Realtime: not wired in this checkpoint — the comments load fresh
 * on every navigation and the page revalidates after each write, so
 * a single user's view is always consistent. Cross-user live updates
 * are a follow-up (would broadcast `comment.created` on the existing
 * tenant SSE channel).
 */
export function CommentsThread({
  tenantId,
  entityType,
  entityId,
  currentUserId,
  initialComments,
  authorLookup,
  teammates,
  canWrite,
}: {
  tenantId: string;
  entityType: EntityType;
  entityId: string;
  currentUserId: string;
  initialComments: Comment[];
  authorLookup: Record<string, string>;
  teammates: Teammate[];
  canWrite: boolean;
}) {
  const [items, setItems] = useState<CommentItem[]>(initialComments);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Live merge: when another user posts a comment on this same
  // entity, drop it into the local list. Filters by entity scope
  // (the SSE channel is tenant-wide so most events aren't ours).
  // Optimistic creates are reconciled by id so we don't double-render.
  useRealtimeEvents(tenantId, (event) => {
    if (event.type !== 'comment.created') return;
    if (event.entityType !== entityType || event.entityId !== entityId) return;
    const incoming = event.comment;
    setItems((prev) => {
      if (prev.some((p) => p.id === incoming.id)) return prev;
      return [
        ...prev,
        {
          id: incoming.id,
          tenantId: incoming.tenantId,
          entityType: incoming.entityType,
          entityId: incoming.entityId,
          authorUserId: incoming.authorUserId,
          parentCommentId: incoming.parentCommentId,
          body: incoming.body,
          mentionedUserIds: incoming.mentionedUserIds,
          editedAt: incoming.editedAt ? new Date(incoming.editedAt) : null,
          createdAt: new Date(incoming.createdAt),
          updatedAt: new Date(incoming.createdAt),
          deletedAt: null,
          deletedBy: null,
        },
      ];
    });
  });

  // Group by parent. Top-level comments at the root; replies nested
  // under each.
  const { topLevel, repliesByParent } = useMemo(() => {
    const top: CommentItem[] = [];
    const replies = new Map<string, CommentItem[]>();
    for (const c of items) {
      if (c.parentCommentId) {
        const arr = replies.get(c.parentCommentId) ?? [];
        arr.push(c);
        replies.set(c.parentCommentId, arr);
      } else {
        top.push(c);
      }
    }
    // Replies keep their own chronological order; ascending is right.
    for (const arr of replies.values()) {
      arr.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    }
    top.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    return { topLevel: top, repliesByParent: replies };
  }, [items]);

  const submit = useCallback(
    (body: string, parentCommentId: string | null) => {
      const optimistic: CommentItem = {
        id: `optimistic-${crypto.randomUUID()}`,
        tenantId: '',
        entityType,
        entityId,
        authorUserId: currentUserId,
        parentCommentId,
        body,
        mentionedUserIds: [],
        editedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        deletedBy: null,
        __pending: true,
      };
      setItems((prev) => [...prev, optimistic]);
      setReplyingTo(null);
      startTransition(async () => {
        const result = await createCommentAction({
          body,
          entityType,
          entityId,
          parentCommentId,
        });
        if (!result.ok) {
          setItems((prev) => prev.filter((c) => c.id !== optimistic.id));
          toast.error(result.message);
        } else {
          setItems((prev) =>
            prev.map((c) => (c.id === optimistic.id ? result.comment : c)),
          );
        }
      });
    },
    [entityType, entityId, currentUserId],
  );

  const saveEdit = useCallback((id: string, body: string) => {
    setItems((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, body, editedAt: new Date(), __pending: true } : c,
      ),
    );
    setEditingId(null);
    startTransition(async () => {
      const result = await updateCommentAction({ id, body });
      if (!result.ok) {
        toast.error(result.message);
      } else {
        setItems((prev) =>
          prev.map((c) =>
            c.id === id ? { ...result.comment, __pending: false } : c,
          ),
        );
      }
    });
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((c) => c.id !== id));
    startTransition(async () => {
      const result = await deleteCommentAction(id);
      if (!result.ok) toast.error(result.message);
    });
  }, []);

  const totalCount =
    topLevel.length +
    Array.from(repliesByParent.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5">
          <MessageCircle className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
          <h2 className="text-[13px] font-semibold text-slate-900">Comments</h2>
        </div>
        <span className="text-[10px] tabular-nums text-slate-400">
          {totalCount}
        </span>
      </header>

      {totalCount === 0 ? (
        <p className="mb-3 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-[12px] text-slate-500">
          No comments yet. Mention a teammate with{' '}
          <code className="rounded bg-slate-200 px-1 text-[11px]">@</code> to
          start a discussion.
        </p>
      ) : (
        <ol className="mb-4 flex flex-col gap-3">
          {topLevel.map((c) => (
            <CommentItemView
              key={c.id}
              comment={c}
              replies={repliesByParent.get(c.id) ?? []}
              authorLookup={authorLookup}
              currentUserId={currentUserId}
              canWrite={canWrite}
              editingId={editingId}
              setEditingId={setEditingId}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              onSaveEdit={saveEdit}
              onDelete={remove}
              onReply={(body, parentId) => submit(body, parentId)}
              teammates={teammates}
              pending={pending}
            />
          ))}
        </ol>
      )}

      {canWrite && replyingTo === null && editingId === null ? (
        <CommentComposer
          placeholder="Add a comment — type @ to mention a teammate"
          submitLabel="Comment"
          teammates={teammates}
          onSubmit={(body) => submit(body, null)}
          pending={pending}
        />
      ) : null}
    </section>
  );
}

/* ============================================================ */
/* Comment row                                                   */
/* ============================================================ */

function CommentItemView({
  comment,
  replies,
  authorLookup,
  currentUserId,
  canWrite,
  editingId,
  setEditingId,
  replyingTo,
  setReplyingTo,
  onSaveEdit,
  onDelete,
  onReply,
  teammates,
  pending,
}: {
  comment: CommentItem;
  replies: CommentItem[];
  authorLookup: Record<string, string>;
  currentUserId: string;
  canWrite: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  replyingTo: string | null;
  setReplyingTo: (id: string | null) => void;
  onSaveEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onReply: (body: string, parentId: string) => void;
  teammates: Teammate[];
  pending: boolean;
}) {
  const isOptimistic = comment.id.startsWith('optimistic-');
  const editable =
    canWrite &&
    comment.authorUserId === currentUserId &&
    !isOptimistic;
  const isEditing = editingId === comment.id;
  const isReplying = replyingTo === comment.id;
  const author = authorLookup[comment.authorUserId] ?? 'Teammate';

  return (
    <li className="flex flex-col gap-2">
      <div className="group flex items-start gap-2.5">
        <Avatar name={author} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold text-slate-800">
              {author}
            </span>
            <span className="text-[10px] tabular-nums text-slate-400">
              {relTime(new Date(comment.createdAt))}
              {comment.editedAt ? ' · edited' : ''}
            </span>
            {comment.__pending && !isOptimistic ? (
              <Loader2 className="h-3 w-3 animate-spin text-slate-400" aria-hidden />
            ) : null}
          </div>
          {isEditing ? (
            <InlineEdit
              initial={comment.body}
              teammates={teammates}
              onSave={(body) => onSaveEdit(comment.id, body)}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-700">
              <RenderBody body={comment.body} currentUserId={currentUserId} />
            </div>
          )}
          {!isEditing ? (
            <div className="mt-1 flex items-center gap-1 text-[10.5px] opacity-0 transition group-hover:opacity-100">
              {canWrite && !isOptimistic ? (
                <button
                  type="button"
                  onClick={() =>
                    setReplyingTo(isReplying ? null : comment.id)
                  }
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                >
                  <Reply className="h-3 w-3" aria-hidden />
                  Reply
                </button>
              ) : null}
              {editable ? (
                <>
                  <button
                    type="button"
                    onClick={() => setEditingId(comment.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(comment.id)}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                    Delete
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {replies.length > 0 ? (
        <ul className="ml-8 flex flex-col gap-2 border-l-2 border-slate-100 pl-3">
          {replies.map((reply) => (
            <ReplyRow
              key={reply.id}
              comment={reply}
              authorLookup={authorLookup}
              currentUserId={currentUserId}
              canWrite={canWrite}
              editingId={editingId}
              setEditingId={setEditingId}
              onSaveEdit={onSaveEdit}
              onDelete={onDelete}
              teammates={teammates}
            />
          ))}
        </ul>
      ) : null}

      {isReplying ? (
        <div className="ml-8">
          <CommentComposer
            placeholder={`Reply to ${author}…`}
            submitLabel="Reply"
            teammates={teammates}
            onSubmit={(body) => onReply(body, comment.id)}
            onCancel={() => setReplyingTo(null)}
            pending={pending}
            autoFocus
            compact
          />
        </div>
      ) : null}
    </li>
  );
}

function ReplyRow({
  comment,
  authorLookup,
  currentUserId,
  canWrite,
  editingId,
  setEditingId,
  onSaveEdit,
  onDelete,
  teammates,
}: {
  comment: CommentItem;
  authorLookup: Record<string, string>;
  currentUserId: string;
  canWrite: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onSaveEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  teammates: Teammate[];
}) {
  const isOptimistic = comment.id.startsWith('optimistic-');
  const editable =
    canWrite &&
    comment.authorUserId === currentUserId &&
    !isOptimistic;
  const isEditing = editingId === comment.id;
  const author = authorLookup[comment.authorUserId] ?? 'Teammate';
  return (
    <li className="group flex items-start gap-2">
      <CornerDownRight
        className="mt-1 h-3 w-3 shrink-0 text-slate-300"
        aria-hidden
      />
      <Avatar name={author} small />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-slate-800">
            {author}
          </span>
          <span className="text-[10px] tabular-nums text-slate-400">
            {relTime(new Date(comment.createdAt))}
            {comment.editedAt ? ' · edited' : ''}
          </span>
        </div>
        {isEditing ? (
          <InlineEdit
            initial={comment.body}
            teammates={teammates}
            onSave={(body) => onSaveEdit(comment.id, body)}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700">
            <RenderBody body={comment.body} currentUserId={currentUserId} />
          </div>
        )}
        {!isEditing && editable ? (
          <div className="mt-0.5 flex items-center gap-1 text-[10.5px] opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              onClick={() => setEditingId(comment.id)}
              className="inline-flex items-center gap-1 rounded px-1 py-0 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <Pencil className="h-3 w-3" aria-hidden />
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDelete(comment.id)}
              className="inline-flex items-center gap-1 rounded px-1 py-0 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function InlineEdit({
  initial,
  teammates,
  onSave,
  onCancel,
}: {
  initial: string;
  teammates: Teammate[];
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1">
      <CommentComposer
        initial={initial}
        teammates={teammates}
        placeholder=""
        submitLabel="Save"
        onSubmit={(body) => onSave(body)}
        onCancel={onCancel}
        compact
        autoFocus
        pending={false}
      />
    </div>
  );
}

function RenderBody({
  body,
  currentUserId,
}: {
  body: string;
  currentUserId: string;
}) {
  return (
    <>
      {parseMentions(body).map((run, i) => {
        if (run.kind === 'mention') {
          const isMe = run.userId === currentUserId;
          return (
            <span
              key={i}
              className={cn(
                'inline-flex rounded px-0.5 font-medium',
                isMe
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-indigo-50 text-indigo-700',
              )}
            >
              @{run.displayName}
            </span>
          );
        }
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}

function Avatar({ name, small }: { name: string; small?: boolean }) {
  const initials = name
    .split(/\s+|-/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-700',
        small ? 'h-4 w-4 text-[9px]' : 'h-6 w-6 text-[11px]',
      )}
    >
      {initials || '?'}
    </span>
  );
}

/* ============================================================ */
/* Composer with inline @ mention picker                         */
/* ============================================================ */

function CommentComposer({
  placeholder,
  submitLabel,
  initial = '',
  teammates,
  onSubmit,
  onCancel,
  pending,
  compact,
  autoFocus,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  teammates: Teammate[];
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  pending: boolean;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(initial);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);

  // Detect a trailing `@<token>` immediately before the caret. If
  // found, surface the picker filtered by that token.
  function updateMentionState(value: string, caret: number) {
    const before = value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) {
      setMentionQuery(null);
      return;
    }
    // Mention is valid only if the char before '@' is start-of-string
    // or whitespace.
    const prev = at === 0 ? ' ' : before[at - 1]!;
    if (!/\s/.test(prev)) {
      setMentionQuery(null);
      return;
    }
    const token = before.slice(at + 1);
    // The token is "active" as long as it has no whitespace.
    if (/\s/.test(token)) {
      setMentionQuery(null);
      return;
    }
    setMentionQuery(token);
    setMentionHighlight(0);
  }

  const filteredTeammates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    if (q === '') return teammates.slice(0, 8);
    return teammates
      .filter(
        (t) =>
          t.displayName.toLowerCase().includes(q) ||
          (t.email ?? '').toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [mentionQuery, teammates]);

  function insertMention(t: Teammate) {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const replaced =
      before.slice(0, at) +
      formatMentionToken(t.displayName, t.id) +
      ' ' +
      after;
    setDraft(replaced);
    setMentionQuery(null);
    // Restore focus + caret position past the inserted token.
    const nextCaret =
      at + formatMentionToken(t.displayName, t.id).length + 1;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function handleSubmit() {
    const body = draft.trim();
    if (!body) return;
    onSubmit(body);
    setDraft('');
  }

  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [autoFocus]);

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          updateMentionState(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mentionQuery !== null && filteredTeammates.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMentionHighlight(
                (i) => (i + 1) % filteredTeammates.length,
              );
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionHighlight(
                (i) =>
                  (i - 1 + filteredTeammates.length) %
                  filteredTeammates.length,
              );
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const t = filteredTeammates[mentionHighlight];
              if (t) insertMention(t);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMentionQuery(null);
              return;
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
          } else if (e.key === 'Escape' && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        className={cn(
          'w-full resize-y rounded-md border border-slate-200 bg-white px-3 py-2 text-[13px] placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20',
        )}
      />

      {mentionQuery !== null && filteredTeammates.length > 0 ? (
        <div className="absolute bottom-[calc(100%+4px)] left-0 z-30 w-[18rem] overflow-hidden rounded-md border border-slate-200 bg-white shadow-md">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500">
            Mention teammate
          </div>
          <ul className="max-h-[14rem] overflow-y-auto">
            {filteredTeammates.map((t, i) => (
              <li key={t.id}>
                <button
                  type="button"
                  onMouseEnter={() => setMentionHighlight(i)}
                  onClick={() => insertMention(t)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12.5px] transition-colors',
                    i === mentionHighlight
                      ? 'bg-indigo-50 text-indigo-700'
                      : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  <Avatar name={t.displayName} small />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.displayName}</div>
                    {t.email ? (
                      <div className="truncate text-[10px] text-slate-500">
                        {t.email}
                      </div>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-end gap-2 text-[11px]">
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin text-slate-400" aria-hidden />
        ) : null}
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-3 w-3" aria-hidden />
            Cancel
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!draft.trim() || pending}
          className="rounded bg-indigo-600 px-2 py-1 font-medium text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitLabel}
          <span className="ml-1 text-[10px] text-indigo-200">⌘⏎</span>
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
