'use server';

import { db } from '@/db';
import { withTenantSession } from '@/lib/auth-guard';
import {
  type DraftContextKind,
  DRAFT_CONTEXT_KINDS,
} from '@/db/schema';
import {
  findDraft,
  saveDraft,
  deleteDraft,
} from '@/lib/communications/drafts/queries';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

/**
 * Server action: save (INSERT-or-UPDATE) a draft.
 *
 * Client semantics: the composer sends `expectedVersion` matching
 * what it last fetched. If the server's stored version has moved
 * past that (another tab raced ahead), the action returns the
 * canonical row and the client merges.
 *
 * On a successful save we publish `communication.draft.updated` on
 * the tenant SSE channel — sibling tabs of the same user listen,
 * compare `userId === currentUserId`, and re-fetch.
 */
export async function saveDraftAction(input: {
  contextKind: DraftContextKind;
  threadId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  subject?: string;
  bodyHtml?: string | null;
  bodyText?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  expectedVersion: number;
}) {
  if (!DRAFT_CONTEXT_KINDS.includes(input.contextKind)) {
    return { ok: false as const, reason: 'invalid' as const, message: 'Bad context kind' };
  }
  return await withTenantSession(async ({ tenant, userId }) => {
    const result = await saveDraft(tenant.id, userId, input);
    if (result.ok) {
      await publishRealtimeEvent(db, {
        type: 'communication.draft.updated',
        tenantId: tenant.id,
        userId,
        draftId: result.draft.id,
        version: result.draft.version,
      });
    }
    return result;
  });
}

/** Server action: fetch the current draft for a context. */
export async function getDraftAction(input: {
  contextKind: DraftContextKind;
  threadId?: string;
  entityType?: string;
  entityId?: string;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    const draft = await findDraft(tenant.id, userId, input);
    return { ok: true as const, draft };
  });
}

/** Server action: discard a draft. */
export async function deleteDraftAction(input: {
  contextKind: DraftContextKind;
  threadId?: string;
  entityType?: string;
  entityId?: string;
}) {
  return await withTenantSession(async ({ tenant, userId }) => {
    await deleteDraft(tenant.id, userId, input);
    return { ok: true as const };
  });
}
