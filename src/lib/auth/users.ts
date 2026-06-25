import 'server-only';

import { randomBytes } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { cache } from 'react';

import { db } from '@/db';
import { users, type User } from '@/db/schema';

/**
 * Direct (non-RLS) access to the local user identity table. Users are a
 * global, cross-tenant concept — looked up by id/email before any tenant
 * context exists — so every helper here runs on the unrestricted `db`.
 */

/** New users created after the Clerk cutover get an `usr_<hex>` id. */
export function generateUserId(): string {
  return `usr_${randomBytes(16).toString('hex')}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Memoized per request: the dashboard layout, header account, and several
// enrichment paths look up the same user id within one render pass.
export const getUserById = cache(async (id: string): Promise<User | null> => {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
});

export async function getUserByEmail(email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

export async function getUsersByIds(ids: string[]): Promise<User[]> {
  if (ids.length === 0) return [];
  return await db.select().from(users).where(inArray(users.id, ids));
}

export async function createUser(input: {
  email: string;
  passwordHash?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string | null;
  emailVerified?: boolean;
}): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      id: generateUserId(),
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      imageUrl: input.imageUrl ?? null,
      emailVerified: input.emailVerified ?? false,
    })
    .returning();
  return row!;
}

export async function setUserPassword(
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, emailVerified: true })
    .where(eq(users.id, userId));
}

export function displayNameForUser(
  u: Pick<User, 'firstName' | 'lastName' | 'email'>,
): string {
  const parts = [u.firstName, u.lastName].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' ') : u.email;
}
