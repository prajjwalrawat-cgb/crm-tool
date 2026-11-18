import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Provider credentials at rest: AES-256-GCM, key from env `KMS_KEY`
 * (32 bytes, given as 64 hex chars or base64). Stored layout:
 *   version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext
 * The key never touches the database; losing it makes stored credentials
 * unreadable (re-enter them), it does not expose them.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export class MissingKmsKeyError extends Error {
  constructor() {
    super(
      'KMS_KEY is not set (or not 32 bytes). Set KMS_KEY to 64 hex characters or a base64 32-byte key to store telephony credentials.',
    );
    this.name = 'MissingKmsKeyError';
  }
}

export function loadKmsKey(raw: string | undefined = process.env.KMS_KEY): Buffer {
  const v = (raw ?? '').trim();
  if (!v) throw new MissingKmsKeyError();
  let key: Buffer | null = null;
  if (/^[0-9a-f]{64}$/i.test(v)) key = Buffer.from(v, 'hex');
  else {
    try {
      const b = Buffer.from(v, 'base64');
      if (b.length === 32) key = b;
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) throw new MissingKmsKeyError();
  return key;
}

export function encryptJson(value: unknown, key: Buffer = loadKmsKey()): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function decryptJson<T = unknown>(blob: Buffer | Uint8Array, key: Buffer = loadKmsKey()): T {
  const buf = Buffer.from(blob);
  if (buf.length < 1 + IV_LEN + TAG_LEN || buf[0] !== VERSION) {
    throw new Error('Unrecognized credential envelope');
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}

export function generateWebhookSecret(): string {
  return randomBytes(24).toString('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
