'use server';

import { and, eq, gt, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db';
import { passwordResetTokens } from '@/db/schema';
import { sendPasswordResetEmail } from '@/lib/auth/email';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { auth } from '@/lib/auth/server';
import { clearSession, setSession } from '@/lib/auth/session';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import {
  createUser,
  getUserByEmail,
  getUserById,
  normalizeEmail,
  setUserPassword,
} from '@/lib/auth/users';
import {
  canCreateWorkspace,
  listUserWorkspaces,
  userHasMembership,
} from '@/lib/auth/workspaces';
import { createTenant } from '@/lib/tenant';
import {
  acceptInvitation,
  getInvitationByToken,
} from '@/lib/team/invitations';

export type AuthFormState = {
  error?: string;
  /** Set by the forgot-password action to flip the form into a sent state. */
  sent?: boolean;
};

const PASSWORD_MIN = 8;

/** Only allow same-origin relative redirects from a `next` form field. */
function safeNext(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return null;
}

/* ----------------------------- SIGN IN ----------------------------- */

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export async function signInAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'Enter your email and password.' };

  const user = await getUserByEmail(parsed.data.email);
  // Same generic message whether the user is missing, has no password set
  // yet (migrated), or the password is wrong — no account enumeration.
  if (!user || !user.passwordHash) {
    return { error: 'Invalid email or password.' };
  }
  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) return { error: 'Invalid email or password.' };

  const workspaces = await listUserWorkspaces(user.id);
  const tid = workspaces[0]?.tenantId ?? null;
  await setSession({ sub: user.id, tid });

  const next = safeNext(formData.get('next'));
  redirect(next ?? (tid ? '/dashboard' : '/select-org'));
}

/* ----------------------------- SIGN UP ----------------------------- */

const signUpSchema = z.object({
  email: z.email({ message: 'Enter a valid email address' }),
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

export async function signUpAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    firstName: formData.get('firstName') || undefined,
    lastName: formData.get('lastName') || undefined,
  });
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).formErrors[0] ?? 'Please fix the form.' };
  }

  const existing = await getUserByEmail(parsed.data.email);
  if (existing) {
    return { error: 'An account with this email already exists. Sign in instead.' };
  }

  // Invite-only: creating an account requires a valid, unexpired invitation
  // addressed to this exact email. We validate the token BEFORE creating the
  // user so a bad/missing token never leaves an orphaned, workspace-less
  // account behind. There is no self-serve "create your own workspace" path.
  const rawToken = formData.get('token');
  const inviteToken = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!inviteToken) {
    return {
      error:
        'Sign-up is invite-only. Ask a workspace admin to send you an invitation.',
    };
  }
  const invite = await getInvitationByToken(inviteToken);
  if (!invite) {
    return { error: 'This invitation is invalid or has expired.' };
  }
  if (normalizeEmail(parsed.data.email) !== invite.invitation.email) {
    return {
      error: 'This invitation was sent to a different email address.',
    };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await createUser({
    email: parsed.data.email,
    passwordHash,
    firstName: parsed.data.firstName ?? null,
    lastName: parsed.data.lastName ?? null,
    emailVerified: true,
  });

  const res = await acceptInvitation({
    token: inviteToken,
    userId: user.id,
    userEmail: user.email,
  });
  if (!res.ok) {
    // The invite was valid moments ago but couldn't be consumed (e.g. it was
    // just revoked or accepted elsewhere). The account exists but has no
    // workspace; send them to sign-in with a clear message.
    return { error: res.message };
  }

  await setSession({ sub: user.id, tid: res.tenant.id });
  redirect('/dashboard');
}

/* ----------------------------- SIGN OUT ---------------------------- */

export async function signOutAction(): Promise<void> {
  await clearSession();
  redirect('/sign-in');
}

/* ------------------------ FORGOT PASSWORD -------------------------- */

const forgotSchema = z.object({ email: z.email() });
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function requestPasswordResetAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = forgotSchema.safeParse({ email: formData.get('email') });
  // Always report "sent" to avoid revealing whether the email exists.
  if (parsed.success) {
    const user = await getUserByEmail(parsed.data.email);
    if (user) {
      const token = generateToken();
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      await sendPasswordResetEmail({
        to: user.email,
        token,
        initial: !user.passwordHash,
      });
    }
  }
  return { sent: true };
}

/* ------------------------- RESET PASSWORD -------------------------- */

const resetSchema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`),
});

export async function resetPasswordAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = resetSchema.safeParse({
    token: formData.get('token'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).formErrors[0] ?? 'Invalid input.' };
  }

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, hashToken(parsed.data.token)),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) {
    return { error: 'This reset link is invalid or has expired.' };
  }

  await setUserPassword(row.userId, await hashPassword(parsed.data.password));
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, row.id));

  redirect('/sign-in?reset=1');
}

/* ----------------------- ACCEPT INVITE ----------------------------- */

export async function acceptInviteAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const token = String(formData.get('token') ?? '');
  if (!token) return { error: 'Missing invitation token.' };

  const { userId } = await auth();
  if (!userId) {
    redirect(`/sign-in?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`);
  }
  const me = await getUserById(userId);
  if (!me) redirect('/sign-in');

  const res = await acceptInvitation({
    token,
    userId: me.id,
    userEmail: me.email,
  });
  if (!res.ok) return { error: res.message };

  await setSession({ sub: me.id, tid: res.tenant.id });
  redirect('/dashboard');
}

/* --------------------- SET ACTIVE WORKSPACE ------------------------ */

export async function setActiveTenantAction(tenantId: string): Promise<void> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const ok = await userHasMembership(userId, tenantId);
  if (ok) {
    await setSession({ sub: userId, tid: tenantId });
  }
  redirect(ok ? '/dashboard' : '/select-org');
}

/* ----------------------- CREATE WORKSPACE -------------------------- */

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(80),
});

export async function createWorkspaceAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');

  // Only admins/owners may create workspaces (a brand-new user with no
  // workspace yet is allowed to bootstrap their first one).
  if (!(await canCreateWorkspace(userId))) {
    return { error: 'Only an admin can create a workspace.' };
  }

  const parsed = createWorkspaceSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { error: z.flattenError(parsed.error).formErrors[0] ?? 'Enter a workspace name.' };
  }

  const tenant = await createTenant({ name: parsed.data.name, ownerUserId: userId });
  await setSession({ sub: userId, tid: tenant.id });
  redirect('/dashboard');
}
