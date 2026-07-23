import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * AES-256-GCM encryption for Gmail OAuth refresh tokens at rest (Module 3).
 * The repo had no reversible-secret helper, so this is the canonical one.
 *
 * Key: `EMAIL_SYNC_ENCRYPTION_KEY` from env, hashed to a fixed 32 bytes with
 * SHA-256 so any sufficiently-long secret works. NEVER store a token without
 * encrypting it, and never log plaintext tokens.
 *
 * Ciphertext format (compact, self-describing): `v1:<iv>:<authTag>:<data>`,
 * each part base64. The GCM auth tag makes tampering detectable on decrypt.
 */

const VERSION = 'v1';

function key(): Buffer {
  const secret = process.env.EMAIL_SYNC_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      'EMAIL_SYNC_ENCRYPTION_KEY is missing or too short — refusing to handle Gmail tokens without encryption. Set a 32+ char secret.',
    );
  }
  return createHash('sha256').update(secret).digest();
}

/** True when a usable encryption key is configured (for setup checks/UI). */
export function isEmailSyncKeyConfigured(): boolean {
  const secret = process.env.EMAIL_SYNC_ENCRYPTION_KEY;
  return Boolean(secret && secret.length >= 16);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted secret');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64!, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
