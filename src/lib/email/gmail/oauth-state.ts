import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed OAuth `state` for the Gmail connect flow — HMAC-SHA256 over
 * {tenantId, userId, exp} using EMAIL_SYNC_ENCRYPTION_KEY. Prevents CSRF (an
 * attacker can't forge a valid state) and bounds replay via a short expiry. The
 * callback additionally cross-checks the decoded ids against the live session.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

function secret(): string {
  const s = process.env.EMAIL_SYNC_ENCRYPTION_KEY;
  if (!s) throw new Error('EMAIL_SYNC_ENCRYPTION_KEY not set');
  return s;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function signState(input: {
  tenantId: string;
  userId: string;
  now?: number;
}): string {
  const body = {
    t: input.tenantId,
    u: input.userId,
    exp: (input.now ?? Date.now()) + TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyState(
  state: string | null,
  now = Date.now(),
): { tenantId: string; userId: string } | null {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof body.exp !== 'number' || body.exp < now) return null;
    if (typeof body.t !== 'string' || typeof body.u !== 'string') return null;
    return { tenantId: body.t, userId: body.u };
  } catch {
    return null;
  }
}
