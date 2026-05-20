import 'server-only';

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import {
  communicationDrafts,
  type CommunicationDraft,
} from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import type {
  DraftLookupKey,
  DraftSaveInput,
  DraftSaveResult,
  DraftSnapshot,
} from './types';

function snapshotOf(row: CommunicationDraft): DraftSnapshot {
  return {
    id: row.id,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    toRecipients: row.toRecipients,
    ccRecipients: row.ccRecipients,
    bccRecipients: row.bccRecipients,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/**
 * Build the WHERE clause that locates a draft by its uniqueness key.
 * Two drafts coexist when they differ on any of: contextKind,
 * threadId-or-null, entityType-or-null, entityId-or-null.
 */
function lookupConditions(
  tenantId: string,
  userId: string,
  key: DraftLookupKey,
): SQL[] {
  const conds: SQL[] = [
    eq(communicationDrafts.tenantId, tenantId),
    eq(communicationDrafts.userId, userId),
    eq(communicationDrafts.contextKind, key.contextKind),
  ];
  conds.push(
    key.threadId
      ? eq(communicationDrafts.threadId, key.threadId)
      : isNull(communicationDrafts.threadId),
  );
  conds.push(
    key.entityType
      ? eq(communicationDrafts.entityType, key.entityType)
      : isNull(communicationDrafts.entityType),
  );
  conds.push(
    key.entityId
      ? eq(communicationDrafts.entityId, key.entityId)
      : isNull(communicationDrafts.entityId),
  );
  return conds;
}

/**
 * Find an existing draft. Returns `null` if no draft yet — the
 * composer renders an empty state and saves will INSERT.
 */
export async function findDraft(
  tenantId: string,
  userId: string,
  key: DraftLookupKey,
): Promise<DraftSnapshot | null> {
  const rows = await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(communicationDrafts)
      .where(and(...lookupConditions(tenantId, userId, key)))
      .limit(1),
  );
  return rows[0] ? snapshotOf(rows[0]) : null;
}

/**
 * Save a draft. Returns:
 *   - `{ ok: true, draft }` on a successful write (INSERT or UPDATE)
 *   - `{ ok: false, reason: 'stale', current }` if another tab moved
 *     the version ahead of us; the caller merges and re-saves
 *   - `{ ok: false, reason: 'invalid', message }` on input validation
 *
 * Conflict resolution model: server-authoritative + last-writer-wins
 * once the caller's `expectedVersion` matches. We don't try to
 * three-way merge — the client either resends with the new version
 * or shows the user a conflict prompt.
 */
export async function saveDraft(
  tenantId: string,
  userId: string,
  input: DraftSaveInput,
): Promise<DraftSaveResult> {
  if (input.expectedVersion < 0 || !Number.isFinite(input.expectedVersion)) {
    return { ok: false, reason: 'invalid', message: 'expectedVersion out of range' };
  }

  return await tenantTransaction(async (tx) => {
    const existing = await tx
      .select()
      .from(communicationDrafts)
      .where(and(...lookupConditions(tenantId, userId, input)))
      .limit(1);

    if (existing.length === 0) {
      // First save for this key — INSERT.
      const [row] = await tx
        .insert(communicationDrafts)
        .values({
          tenantId,
          userId,
          contextKind: input.contextKind,
          threadId: input.threadId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          subject: input.subject ?? '',
          bodyHtml: input.bodyHtml ?? null,
          bodyText: input.bodyText ?? '',
          toRecipients: input.toRecipients ?? [],
          ccRecipients: input.ccRecipients ?? [],
          bccRecipients: input.bccRecipients ?? [],
          version: 1,
        })
        .returning();
      if (!row) {
        return {
          ok: false,
          reason: 'invalid',
          message: 'INSERT returned no row (RLS?)',
        };
      }
      return { ok: true, draft: snapshotOf(row) };
    }

    const current = existing[0]!;
    if (current.version > input.expectedVersion) {
      return {
        ok: false,
        reason: 'stale',
        current: snapshotOf(current),
      };
    }

    // expectedVersion matches → UPDATE + bump.
    const [updated] = await tx
      .update(communicationDrafts)
      .set({
        subject: input.subject ?? current.subject,
        bodyHtml:
          input.bodyHtml === undefined ? current.bodyHtml : input.bodyHtml,
        bodyText: input.bodyText ?? current.bodyText,
        toRecipients: input.toRecipients ?? current.toRecipients,
        ccRecipients: input.ccRecipients ?? current.ccRecipients,
        bccRecipients: input.bccRecipients ?? current.bccRecipients,
        version: sql`${communicationDrafts.version} + 1`,
      })
      .where(eq(communicationDrafts.id, current.id))
      .returning();
    if (!updated) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'UPDATE returned no row (RLS?)',
      };
    }
    return { ok: true, draft: snapshotOf(updated) };
  });
}

/**
 * Delete a draft (called by the send path after the message lands).
 */
export async function deleteDraft(
  tenantId: string,
  userId: string,
  key: DraftLookupKey,
): Promise<void> {
  await tenantTransaction(async (tx) =>
    tx
      .delete(communicationDrafts)
      .where(and(...lookupConditions(tenantId, userId, key))),
  );
}

/**
 * Per-user list at the "Drafts" inbox tab. Newest-updated first.
 */
export async function listMyDrafts(
  tenantId: string,
  userId: string,
  options: { limit?: number } = {},
): Promise<CommunicationDraft[]> {
  const limit = options.limit ?? 50;
  return await tenantTransaction(async (tx) =>
    tx
      .select()
      .from(communicationDrafts)
      .where(
        and(
          eq(communicationDrafts.tenantId, tenantId),
          eq(communicationDrafts.userId, userId),
        ),
      )
      .orderBy(sql`${communicationDrafts.updatedAt} DESC`)
      .limit(limit),
  );
}
