import 'server-only';

import { cookies } from 'next/headers';

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifySession,
  type SessionClaims,
} from './jwt';

/**
 * Server-side session cookie I/O. `getSessionClaims` is safe from any
 * server component; `setSession` / `clearSession` must be called from a
 * server action or route handler (Next forbids mutating cookies during
 * a render).
 */

export async function getSessionClaims(): Promise<SessionClaims | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

export async function setSession(claims: SessionClaims): Promise<void> {
  const token = await signSession(claims);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
