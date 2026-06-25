import 'server-only';

import type { User } from '@/db/schema';

import { getSessionClaims } from './session';
import { getUserById, getUsersByIds } from './users';

/**
 * Compatibility shims that mirror the slice of the Clerk server SDK the
 * app relied on (`auth()`, `currentUser()`, `clerkClient().users.*`).
 * Backed entirely by the local `users` table and session cookie, so the
 * ~20 former Clerk call sites only had to change their import path.
 *
 * Note: `orgId` is the active tenant's UUID (not a Clerk org id), and
 * `orgRole` is always null — the `memberships` table is the single
 * source of truth for roles.
 */

export async function auth(): Promise<{
  userId: string | null;
  orgId: string | null;
  orgRole: string | null;
}> {
  const claims = await getSessionClaims();
  return {
    userId: claims?.sub ?? null,
    orgId: claims?.tid ?? null,
    orgRole: null,
  };
}

type ShimEmail = { id: string; emailAddress: string };

/** Clerk-user-shaped view over a local user row. */
export type ShimUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string;
  primaryEmailAddressId: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
  emailAddresses: ShimEmail[];
};

function toShimUser(u: User): ShimUser {
  const emailId = `email_${u.id}`;
  return {
    id: u.id,
    firstName: u.firstName,
    lastName: u.lastName,
    username: null,
    imageUrl: u.imageUrl ?? '',
    primaryEmailAddressId: emailId,
    primaryEmailAddress: { emailAddress: u.email },
    emailAddresses: [{ id: emailId, emailAddress: u.email }],
  };
}

export async function currentUser(): Promise<ShimUser | null> {
  const claims = await getSessionClaims();
  if (!claims?.sub) return null;
  const u = await getUserById(claims.sub);
  return u ? toShimUser(u) : null;
}

/**
 * Minimal `clerkClient()` stand-in — only the `users.getUser` /
 * `users.getUserList` surface the app used. `getUser` throws on a
 * missing id to match Clerk's behavior (every call site already
 * wraps it in try/catch or `.catch(() => null)`).
 */
export async function clerkClient(): Promise<{
  users: {
    getUser(id: string): Promise<ShimUser>;
    getUserList(args: { userId: string[]; limit?: number }): Promise<{
      data: ShimUser[];
    }>;
  };
}> {
  return {
    users: {
      async getUser(id: string) {
        const u = await getUserById(id);
        if (!u) throw new Error(`User not found: ${id}`);
        return toShimUser(u);
      },
      async getUserList(args: { userId: string[]; limit?: number }) {
        const list = await getUsersByIds(args.userId ?? []);
        return { data: list.map(toShimUser) };
      },
    },
  };
}
