import 'server-only';

// Signing someone in who opened Saleinx from AskMira.
//
// AskMira sends the browser to /sso/askmira#token=… (the fragment never reaches
// a server log). That page posts the token here; if it is good — signed with
// the workspace's connection secret, not used before, naming an active member
// of the connected workspace — the browser gets a normal Saleinx session for
// that workspace. Nobody is created here: Saleinx's own owners and admins
// invite its members, and AskMira never decides a role.

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { askmiraPeople } from '@/db/schema';
import { setSession } from '@/lib/auth/session';

import {
  BRAND,
  EMAIL_RE,
  claimsOf,
  clean,
  httpError,
  memberByEmail,
  normEmail,
  peek,
  spendOnce,
} from './core';

/** Where to land: a plain path inside Saleinx, never another site. */
function landing(next: unknown) {
  const path = String(next ?? '');
  return /^\/(?!\/)[A-Za-z0-9._~/?=&%-]{0,300}$/.test(path) ? path : '/dashboard';
}

export async function launch(token: string, next: unknown) {
  // Not a sign-in link at all (cut short, mistyped): say so, not "disconnected".
  if (!peek(token)?.tid) {
    throw httpError(401, `This AskMira link is not valid. Open ${BRAND} again from AskMira.`);
  }
  let found;
  try {
    found = await claimsOf(token, 'launch');
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status === 404) {
      throw httpError(403, `Your company is not connected to ${BRAND} any more. Ask your HR admin.`);
    }
    throw err;
  }
  const { claims, link, workspace } = found;
  await spendOnce(claims, `This sign-in link was already used. Open ${BRAND} again from AskMira.`);
  if (claims.ext && String(claims.ext) !== link.tenantId) {
    throw httpError(403, `Your company is not connected to ${BRAND} any more. Ask your HR admin.`);
  }
  const email = normEmail(claims.email);
  if (!EMAIL_RE.test(email)) throw httpError(403, `AskMira did not say who you are.`);
  const member = await memberByEmail(link.tenantId, email);
  if (!member) {
    throw httpError(
      403,
      `You are not a member of ${workspace.name} in ${BRAND} yet. Ask your sales admin to invite you.`,
    );
  }
  if (member.status !== 'active') {
    throw httpError(403, `Your ${BRAND} access to ${workspace.name} has been switched off.`);
  }
  const [managed] = await db
    .select({ suspendedAt: askmiraPeople.suspendedAt })
    .from(askmiraPeople)
    .where(and(eq(askmiraPeople.tenantId, link.tenantId), eq(askmiraPeople.userId, member.userId)))
    .limit(1);
  if (managed?.suspendedAt) {
    throw httpError(403, `Your ${BRAND} access to ${workspace.name} has been switched off.`);
  }
  // Remember who AskMira says this is, for the next sync.
  await db
    .insert(askmiraPeople)
    .values({ tenantId: link.tenantId, userId: member.userId, askmiraUserId: clean(claims.sub, 64) })
    .onConflictDoUpdate({
      target: [askmiraPeople.tenantId, askmiraPeople.userId],
      set: { askmiraUserId: clean(claims.sub, 64) },
    });
  await setSession({ sub: member.userId, tid: link.tenantId });
  console.log(`[AskMira] ${email} signed in to ${workspace.name} from AskMira`);
  return { redirect_to: landing(next) };
}
