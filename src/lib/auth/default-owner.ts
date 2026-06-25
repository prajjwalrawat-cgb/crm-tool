import 'server-only';

import { createUser, getUserByEmail } from './users';

/**
 * The address that is seeded as an owner of every workspace — existing
 * ones (via `pnpm seed:owner`) and any newly created one (via
 * `createTenant`). The account is created passwordless; the person signs
 * in for the first time through the "Forgot password" reset flow.
 */
export const DEFAULT_OWNER_EMAIL = 'info@cgbindia.com';

/** Ensure the default-owner user row exists and return its id. */
export async function ensureDefaultOwnerUserId(): Promise<string> {
  const existing = await getUserByEmail(DEFAULT_OWNER_EMAIL);
  if (existing) return existing.id;
  const created = await createUser({
    email: DEFAULT_OWNER_EMAIL,
    passwordHash: null,
    emailVerified: false,
  });
  return created.id;
}
