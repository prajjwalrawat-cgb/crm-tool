import 'server-only';

import {
  type BinaryLike,
  randomBytes,
  scrypt as scryptCb,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing via Node's built-in scrypt — no native dependency,
 * memory-hard, and only ever invoked from server actions (never Edge).
 *
 * Stored format: `scrypt$N$r$p$saltHex$hashHex`. The cost parameters are
 * embedded so they can be tuned later without breaking existing hashes.
 */

const scrypt = promisify(scryptCb) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;
const KEYLEN = 64;
const N = 16384; // CPU/memory cost (~16 MB at r=8)
const R = 8;
const P = 1;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer;
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  const derived = (await scrypt(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
    // scrypt's default maxmem (32 MB) is enough for N=16384,r=8 but be
    // explicit so tuning N upward later doesn't silently throw.
    maxmem: 256 * 1024 * 1024,
  })) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
