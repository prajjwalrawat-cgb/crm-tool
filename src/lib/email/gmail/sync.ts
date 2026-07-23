import 'server-only';

import type { GmailConnection } from '@/db/schema';

import {
  getMessageMetadata,
  getProfile,
  listHistory,
  listRecentMessageIds,
} from './client';
import { getAccessToken, updateSyncState } from './connections';
import { ingestSyncedMessage } from './ingest';
import { determineDirection } from './parse';

/** Cap per-run message processing so one mailbox can't monopolize a sync tick. */
const MAX_PER_RUN = 100;
/** First-sync / cursor-expiry lookback window. */
const FALLBACK_DAYS = 7;

export type SyncStats = {
  processed: number;
  created: number;
  duplicates: number;
  skipped: number;
};

/**
 * Sync one connected mailbox. Uses Gmail `history.list` incremental sync when a
 * cursor exists, falling back to a 7-day `messages.list` window on first sync or
 * a 404 (expired historyId). Every new message runs through the matching +
 * write pipeline (which itself enforces the "no matching contact → write
 * nothing" privacy rule). Persists the fresh cursor + last-sync time.
 */
export async function syncMailbox(
  tenantId: string,
  conn: GmailConnection,
): Promise<SyncStats> {
  const stats: SyncStats = { processed: 0, created: 0, duplicates: 0, skipped: 0 };
  try {
    const accessToken = await getAccessToken(conn);
    const profile = await getProfile(accessToken);

    let messageIds: string[];
    if (conn.historyId) {
      try {
        const hist = await listHistory(accessToken, conn.historyId);
        messageIds = hist.messageIds;
      } catch (err) {
        // Expired cursor → windowed re-sync (idempotency dedups the overlap).
        if ((err as { status?: number }).status === 404) {
          messageIds = await listRecentMessageIds(accessToken, FALLBACK_DAYS);
        } else {
          throw err;
        }
      }
    } else {
      messageIds = await listRecentMessageIds(accessToken, FALLBACK_DAYS);
    }

    for (const id of messageIds.slice(0, MAX_PER_RUN)) {
      const msg = await getMessageMetadata(accessToken, id);
      const direction = determineDirection(msg.from, conn.email);
      const result = await ingestSyncedMessage({
        tenantId,
        actorUserId: conn.userId,
        mailboxEmail: conn.email,
        excludedDomains: conn.excludedDomains,
        excludedAddresses: conn.excludedAddresses,
        message: msg,
        direction,
      });
      stats.processed += 1;
      if (result.status === 'created') stats.created += 1;
      else if (result.status === 'duplicate') stats.duplicates += 1;
      else stats.skipped += 1;
    }

    // Advance the cursor to the mailbox's current historyId for the next run.
    await updateSyncState(tenantId, conn.id, {
      historyId: profile.historyId,
      lastSyncAt: new Date(),
      syncStatus: 'active',
      lastError: null,
    });

    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateSyncState(tenantId, conn.id, {
      syncStatus: 'error',
      lastError: message.slice(0, 500),
      lastSyncAt: new Date(),
    });
    throw err;
  }
}
