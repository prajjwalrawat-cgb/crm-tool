'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { DRAFT_AUTOSAVE_DEBOUNCE_MS } from '@/lib/communications/drafts/types';
import type {
  DraftSnapshot,
  DraftSaveInput,
  DraftSaveResult,
} from '@/lib/communications/drafts/types';
import { useRealtimeEventOfType } from '@/hooks/use-realtime-events';

/**
 * Client hook that owns the lifecycle of an autosaving draft.
 *
 * Contract:
 *   1. Caller provides a save adapter (a thin wrapper around the
 *      server action) and a fetch adapter for reload.
 *   2. Hook holds local state for the composer fields plus the
 *      authoritative `version` returned by the server.
 *   3. Every change triggers a debounced save (default 800ms).
 *   4. On a stale-version response, the hook adopts the server's
 *      canonical row and the local edits are deferred to a manual
 *      "overwrite or merge" decision (v1 just adopts the server).
 *   5. Realtime: a `communication.draft.updated` event whose
 *      `userId === currentUserId` and `draftId === active.draft.id`
 *      triggers a silent re-fetch — covers the multi-tab case.
 *
 * Returned `state` is one of:
 *   `idle`     — no changes since last save
 *   `pending`  — debounce window active, save will fire soon
 *   `saving`   — server request in flight
 *   `saved`    — latest change confirmed by server
 *   `stale`    — server rejected (older version); we've adopted theirs
 *   `error`    — non-stale failure
 */
export type DraftAutosaveState =
  | 'idle'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'stale'
  | 'error';

export type UseDraftAutosaveArgs = {
  tenantId: string;
  currentUserId: string;
  contextKind: DraftSaveInput['contextKind'];
  threadId?: string;
  entityType?: string;
  entityId?: string;
  initial: DraftSnapshot | null;
  save: (input: DraftSaveInput) => Promise<DraftSaveResult>;
  reload: () => Promise<{ draft: DraftSnapshot | null }>;
};

export function useDraftAutosave(args: UseDraftAutosaveArgs) {
  const [draft, setDraft] = useState<DraftSnapshot | null>(args.initial);
  const [state, setState] = useState<DraftAutosaveState>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFieldsRef = useRef<Partial<DraftSnapshot>>({});

  const flush = useCallback(async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const fields = pendingFieldsRef.current;
    pendingFieldsRef.current = {};
    if (Object.keys(fields).length === 0) return;

    setState('saving');
    const expectedVersion = draft?.version ?? 0;
    const result = await args.save({
      contextKind: args.contextKind,
      threadId: args.threadId,
      entityType: args.entityType,
      entityId: args.entityId,
      subject: fields.subject ?? draft?.subject ?? '',
      bodyHtml: fields.bodyHtml === undefined ? draft?.bodyHtml : fields.bodyHtml,
      bodyText: fields.bodyText ?? draft?.bodyText ?? '',
      toRecipients: fields.toRecipients ?? draft?.toRecipients ?? [],
      ccRecipients: fields.ccRecipients ?? draft?.ccRecipients ?? [],
      bccRecipients: fields.bccRecipients ?? draft?.bccRecipients ?? [],
      expectedVersion,
    });
    if (result.ok) {
      setDraft(result.draft);
      setState('saved');
    } else if (result.reason === 'stale') {
      setDraft(result.current);
      setState('stale');
    } else {
      setState('error');
    }
  }, [args, draft]);

  const updateField = useCallback(
    <K extends keyof DraftSnapshot>(key: K, value: DraftSnapshot[K]) => {
      pendingFieldsRef.current[key] = value;
      setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
      setState('pending');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void flush();
      }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Cleanup on unmount: flush any pending changes so a navigation
  // doesn't drop them.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Best-effort: we don't await here because unmount can't.
      if (Object.keys(pendingFieldsRef.current).length > 0) {
        void flush();
      }
    };
  }, [flush]);

  // Multi-tab listener: another tab saved this draft; pull latest.
  useRealtimeEventOfType(args.tenantId, 'communication.draft.updated', async (event) => {
    if (event.userId !== args.currentUserId) return;
    if (!draft || event.draftId !== draft.id) return;
    if (event.version <= draft.version) return;
    const next = await args.reload();
    if (next.draft) {
      setDraft(next.draft);
      setState('saved');
    }
  });

  return { draft, state, updateField, flush };
}
