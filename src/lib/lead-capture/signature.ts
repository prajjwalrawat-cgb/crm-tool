import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook authentication + idempotency. Pure (node:crypto only).
 *
 * A request authenticates with EITHER
 *   - `X-Saleinx-Token: <secret_token>`, or
 *   - `X-Saleinx-Signature: sha256=<hex HMAC-SHA256(raw body, secret_token)>`
 *     (the `sha256=` prefix is optional).
 * Both comparisons are constant-time.
 */

export function generateSourceSecret(): string {
  return randomBytes(32).toString('hex');
}

function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so length mismatch takes similar time.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function signBody(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyIngestAuth(args: {
  rawBody: string;
  secret: string;
  tokenHeader: string | null;
  signatureHeader: string | null;
}): boolean {
  const { rawBody, secret, tokenHeader, signatureHeader } = args;
  if (signatureHeader) {
    const given = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    return safeEqualStrings(given, signBody(rawBody, secret));
  }
  if (tokenHeader) return safeEqualStrings(tokenHeader.trim(), secret);
  return false;
}

/** Stable JSON: object keys sorted recursively, so key order can't defeat dedupe. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256(source_id + canonical payload). Webhook retries map to one key. */
export function ingestIdempotencyKey(sourceId: string, payload: unknown): string {
  return createHash('sha256').update(`${sourceId}\n${canonicalJson(payload)}`).digest('hex');
}
