import 'server-only';

import { isEmailSyncKeyConfigured } from './crypto';
import {
  buildSnippet,
  headerValue,
  parseAddressList,
  type ParsedGmailMessage,
} from './parse';

/**
 * Thin fetch wrapper over the Gmail REST API + Google OAuth2. No `googleapis`
 * dependency — plain HTTPS calls, so nothing heavy enters the bundle.
 *
 * Privacy: message reads use `format=metadata` (From/To/Cc/Subject headers +
 * Gmail's own short `snippet`), so full bodies and attachments are NEVER
 * downloaded, let alone stored.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export type GmailEnv = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

/** All Gmail-sync prerequisites present (OAuth client + encryption key)? */
export function gmailConfigured(): boolean {
  return (
    Boolean(process.env.GMAIL_CLIENT_ID) &&
    Boolean(process.env.GMAIL_CLIENT_SECRET) &&
    Boolean(process.env.GMAIL_OAUTH_REDIRECT_URI) &&
    isEmailSyncKeyConfigured()
  );
}

function env(): GmailEnv {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Gmail OAuth env not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

/** Consent-screen URL. `state` carries our CSRF/session token. */
export function buildAuthUrl(state: string): string {
  const { clientId, redirectUri } = env();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
};

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = env();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token exchange failed: ${res.status}`);
  }
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? null,
    expiresInSec: j.expires_in,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = env();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: j.access_token,
    refreshToken, // Google doesn't reissue on refresh
    expiresInSec: j.expires_in,
  };
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) {
    const err = new Error('GMAIL_404') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Gmail GET ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Mailbox address + current historyId. */
export async function getProfile(
  accessToken: string,
): Promise<{ email: string; historyId: string }> {
  const j = await gmailGet<{ emailAddress: string; historyId: string }>(
    accessToken,
    '/profile',
  );
  return { email: j.emailAddress.toLowerCase(), historyId: j.historyId };
}

/**
 * Incremental sync via history.list. Returns the ids of messages added since
 * `startHistoryId`, plus the newest historyId. Throws an error with
 * `status === 404` when the cursor has expired (caller falls back to a window).
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; historyId: string | null }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | null = null;

  do {
    const p = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const j = await gmailGet<{
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId?: string;
      nextPageToken?: string;
    }>(accessToken, `/history?${p.toString()}`);

    for (const h of j.history ?? []) {
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    }
    if (j.historyId) latestHistoryId = j.historyId;
    pageToken = j.nextPageToken;
  } while (pageToken);

  return { messageIds: Array.from(ids), historyId: latestHistoryId };
}

/**
 * Windowed first-sync fallback: message ids from the last `days` days via
 * messages.list with a Gmail search query.
 */
export async function listRecentMessageIds(
  accessToken: string,
  days: number,
  maxResults = 200,
): Promise<string[]> {
  const p = new URLSearchParams({
    q: `newer_than:${days}d`,
    maxResults: String(maxResults),
  });
  const j = await gmailGet<{ messages?: Array<{ id: string }> }>(
    accessToken,
    `/messages?${p.toString()}`,
  );
  return (j.messages ?? []).map((m) => m.id);
}

/**
 * Fetch one message as metadata only (never the body). Returns the parsed,
 * store-ready shape. Uses Gmail's own `snippet`, re-run through `buildSnippet`
 * to strip any residual quoted text and cap at 200 chars.
 */
export async function getMessageMetadata(
  accessToken: string,
  id: string,
): Promise<ParsedGmailMessage> {
  const p = new URLSearchParams({ format: 'metadata' });
  for (const h of ['From', 'To', 'Cc', 'Subject']) p.append('metadataHeaders', h);
  const j = await gmailGet<{
    id: string;
    threadId?: string;
    internalDate?: string;
    snippet?: string;
    payload?: { headers?: Array<{ name?: string; value?: string }> };
  }>(accessToken, `/messages/${id}?${p.toString()}`);

  const headers = j.payload?.headers ?? [];
  return {
    externalId: j.id,
    threadId: j.threadId ?? null,
    subject: headerValue(headers, 'Subject') ?? '(no subject)',
    snippet: buildSnippet(j.snippet ?? ''),
    timestamp: j.internalDate ? Number(j.internalDate) : Date.now(),
    from: parseAddressList(headerValue(headers, 'From')),
    to: parseAddressList(headerValue(headers, 'To')),
    cc: parseAddressList(headerValue(headers, 'Cc')),
  };
}
