import 'server-only';

import { and, eq } from 'drizzle-orm';

import { gmailConnections, type GmailConnection } from '@/db/schema';
import { tenantTransaction } from '@/lib/db-context';

import { refreshAccessToken } from './client';
import { decryptSecret, encryptSecret } from './crypto';

/** The connection for a user in a tenant, or null. */
export async function getConnection(
  tenantId: string,
  userId: string,
): Promise<GmailConnection | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(gmailConnections)
      .where(
        and(
          eq(gmailConnections.tenantId, tenantId),
          eq(gmailConnections.userId, userId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/** A single connection by id (used by the sync step after id round-trip). */
export async function getConnectionById(
  tenantId: string,
  id: string,
): Promise<GmailConnection | null> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .select()
      .from(gmailConnections)
      .where(
        and(eq(gmailConnections.id, id), eq(gmailConnections.tenantId, tenantId)),
      )
      .limit(1),
  );
  return row ?? null;
}

/** Active connections for a tenant (used by the sync cron's per-tenant fan-out). */
export async function listActiveConnectionsForTenant(
  tenantId: string,
): Promise<GmailConnection[]> {
  return tenantTransaction((tx) =>
    tx
      .select()
      .from(gmailConnections)
      .where(
        and(
          eq(gmailConnections.tenantId, tenantId),
          eq(gmailConnections.syncStatus, 'active'),
        ),
      ),
  );
}

/** Create or replace a user's Gmail connection (OAuth callback). Encrypts the token. */
export async function upsertConnection(input: {
  tenantId: string;
  userId: string;
  email: string;
  refreshToken: string;
  historyId: string | null;
}): Promise<GmailConnection> {
  const refreshTokenEnc = encryptSecret(input.refreshToken);
  const [row] = await tenantTransaction((tx) =>
    tx
      .insert(gmailConnections)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        email: input.email.toLowerCase(),
        refreshTokenEnc,
        historyId: input.historyId,
        syncStatus: 'active',
        lastError: null,
        // Self-exclude the connected mailbox's own domain by default.
        excludedDomains: domainDefault(input.email),
      })
      .onConflictDoUpdate({
        target: [gmailConnections.tenantId, gmailConnections.userId],
        set: {
          email: input.email.toLowerCase(),
          refreshTokenEnc,
          historyId: input.historyId,
          syncStatus: 'active',
          lastError: null,
          updatedAt: new Date(),
        },
      })
      .returning(),
  );
  if (!row) throw new Error('gmail connection upsert failed');
  return row;
}

function domainDefault(email: string): string[] {
  const at = email.lastIndexOf('@');
  return at === -1 ? [] : [email.slice(at + 1).toLowerCase()];
}

/** Disconnect: delete the row (and its encrypted token) immediately. */
export async function deleteConnection(
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await tenantTransaction((tx) =>
    tx
      .delete(gmailConnections)
      .where(
        and(
          eq(gmailConnections.tenantId, tenantId),
          eq(gmailConnections.userId, userId),
        ),
      )
      .returning({ id: gmailConnections.id }),
  );
  return Boolean(row);
}

export async function updateExclusions(
  tenantId: string,
  userId: string,
  patch: { excludedDomains?: string[]; excludedAddresses?: string[] },
): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .update(gmailConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(gmailConnections.tenantId, tenantId),
          eq(gmailConnections.userId, userId),
        ),
      ),
  );
}

export async function updateSyncState(
  tenantId: string,
  connectionId: string,
  patch: {
    historyId?: string | null;
    lastSyncAt?: Date;
    syncStatus?: 'active' | 'error' | 'disconnected';
    lastError?: string | null;
  },
): Promise<void> {
  await tenantTransaction((tx) =>
    tx
      .update(gmailConnections)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(gmailConnections.id, connectionId),
          eq(gmailConnections.tenantId, tenantId),
        ),
      ),
  );
}

/**
 * Decrypt the refresh token and mint a fresh access token. We refresh on every
 * sync (Google access tokens are short-lived and the sync cadence is 10 min) —
 * simpler and safe. The plaintext token exists only in memory here.
 */
export async function getAccessToken(conn: GmailConnection): Promise<string> {
  const refreshToken = decryptSecret(conn.refreshTokenEnc);
  const { accessToken } = await refreshAccessToken(refreshToken);
  return accessToken;
}
