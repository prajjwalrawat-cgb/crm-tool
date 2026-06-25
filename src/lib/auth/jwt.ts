import { SignJWT, jwtVerify } from 'jose';

/**
 * Edge-safe session token primitives. No Next.js APIs imported here so
 * this module is usable from both middleware (Edge runtime) and server
 * components / actions (Node runtime). Cookie I/O lives in session.ts.
 *
 * The session is a stateless HS256 JWT signed with AUTH_SECRET. It proves
 * *identity* only — authorization is always re-checked against the
 * `memberships` table per request, so removing a member revokes their
 * access on their next request regardless of token validity.
 */

export const SESSION_COOKIE = 'crm_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type SessionClaims = {
  /** User id (matches `users.id`). */
  sub: string;
  /** Active tenant id (UUID) or null when no workspace is selected. */
  tid: string | null;
};

let cachedKey: Uint8Array | null = null;
function getKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET environment variable is required');
  }
  cachedKey = new TextEncoder().encode(secret);
  return cachedKey;
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return await new SignJWT({ tid: claims.tid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getKey());
}

export async function verifySession(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') return null;
    const tid = typeof payload.tid === 'string' ? payload.tid : null;
    return { sub: payload.sub, tid };
  } catch {
    // Expired / tampered / wrong-secret tokens all fail closed.
    return null;
  }
}
