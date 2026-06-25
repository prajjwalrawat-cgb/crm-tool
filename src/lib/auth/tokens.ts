import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque single-use tokens for password-reset and invite links. We email
 * the raw token and persist only its SHA-256 hash, so a database leak
 * cannot be replayed against the link endpoints.
 */

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
