import 'server-only';

// The link with AskMiraa, the HRMS a company may run its people in.
//
// An owner or admin of a workspace here connects it to one AskMiraa workspace:
// AskMiraa's admin presses Connect there, lands on /connect/askmira here and
// presses Allow (connect.ts). From then on AskMiraa's server calls here for that
// one workspace only, each call carrying a short-lived HS256 token signed with
// the connection's own secret (aud "askmira:saleinx", iss "askmira"):
//
//   POST /api/integrations/askmira/users/sync      use=provision  the company's people (people.ts)
//   POST /api/integrations/askmira/query           use=query      read for one person (queries.ts)
//   POST /api/integrations/askmira/act             use=act        a lead, a stage move (actions.ts)
//   POST /api/integrations/askmira/connect/token   AskMiraa swaps the one-time code (PKCE)
//   POST /api/integrations/askmira/connect/revoke  use=revoke     AskMiraa disconnected
//   POST /api/integrations/askmira/launch          use=launch     sign a person in (launch.ts)
//
// Server-to-server tokens carry `bh`, the SHA-256 of the exact body, so a
// captured token can't be replayed with another body; `act` and `launch`
// tokens work only once (their `jti`).
//
// Roles are this workspace's own. AskMiraa never grants one: a person is who
// their membership here says (owner, admin, manager, member, viewer), and
// AskMiraa only learns that role, to know what to offer them.

import crypto from 'node:crypto';

import { and, eq, lt } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/db';
import {
  askmiraLinks,
  askmiraPeople,
  askmiraUsedTokens,
  memberships,
  tenants,
  users,
  type AskmiraLink,
  type MembershipRole,
} from '@/db/schema';

export const PRODUCT = 'saleinx';
export const BRAND = 'Saleinx';
export const AUDIENCE = 'askmira:saleinx';
export const ISSUER = 'askmira';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Seconds a token's clock may differ from ours. */
const LEEWAY_S = 10;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** More for AskMiraa beside the message, such as a refusal's `code`. */
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const httpError = (status: number, message: string, extra?: Record<string, unknown>) =>
  new HttpError(status, message, extra);

/** A database error saying a table does not exist (migration 0070 not applied yet). */
function isMissingTable(err: unknown) {
  const text = `${err instanceof Error ? err.message : String(err)} ${
    (err as { cause?: { message?: string } })?.cause?.message ?? ''
  }`;
  return /relation "?[\w.]*askmira_[\w]*"? does not exist/i.test(text);
}

export const SETUP_MESSAGE =
  'This Saleinx is not set up for AskMiraa yet: its database does not have the AskMiraa tables. ' +
  'Whoever runs Saleinx needs to run scripts/apply-0070.ts once (the build does it); then try again.';

/** A route's answer: the result as JSON, or `{ error }` with the status we chose. */
export async function respond(work: () => Promise<unknown>) {
  try {
    return NextResponse.json(await work());
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ ...err.extra, error: err.message }, { status: err.status });
    }
    if (isMissingTable(err)) {
      console.error('[AskMiraa] the AskMiraa tables are missing:', err);
      return NextResponse.json({ error: SETUP_MESSAGE }, { status: 503 });
    }
    console.error('[AskMiraa] request failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ── Small helpers ───────────────────────────────────────── */

export const sha256hex = (value: string | Buffer) =>
  crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function normEmail(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function clean(value: unknown, max = 200): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().slice(0, max);
  return text || null;
}

export function paramsOf(body: Record<string, unknown>) {
  const params = body.params;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

/* ── The connection's secret ─────────────────────────────── */

function serverKey() {
  return process.env.ASKMIRA_LINK_SECRET || process.env.AUTH_SECRET || '';
}

export function canConnect() {
  return serverKey().length >= 32;
}

/** A workspace's AskMiraa secret: derived here, so the database keeps only the nonce. */
export function derive(tenantId: string, nonce: string) {
  return crypto
    .createHmac('sha256', serverKey())
    .update(`askmira-saleinx:v1:${tenantId}:${nonce}`)
    .digest('hex');
}

/* ── Tokens ──────────────────────────────────────────────── */

export type Use = 'provision' | 'query' | 'act' | 'revoke' | 'launch';
export type Claims = Record<string, unknown> & { sub?: string; jti?: string; exp?: number };

function part(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** What a token says, before anyone has checked it. Only used to pick the secret. */
export function peek(token: string): Claims | null {
  const parts = token.split('.');
  return parts.length === 3 ? (part(parts[1]!) as Claims | null) : null;
}

/** The claims of an HS256 token signed with `secret`, or null. */
export function verify(token: string, secret: string): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const header = part(parts[0]!);
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  const given = Buffer.from(parts[2]!, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const claims = part(parts[1]!) as Claims | null;
  if (!claims) return null;
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    claims.iss !== ISSUER ||
    !audience.includes(AUDIENCE) ||
    typeof claims.exp !== 'number' ||
    claims.exp + LEEWAY_S < now ||
    (typeof claims.iat === 'number' && claims.iat - LEEWAY_S > now)
  ) {
    return null;
  }
  return claims;
}

/* ── The connection ──────────────────────────────────────── */

export type Workspace = { id: string; name: string; slug: string };
export type Linked = { link: AskmiraLink; workspace: Workspace };

/** The workspace connected to an AskMiraa workspace, or null. */
export async function linkedTo(askmiraTenantId: string): Promise<Linked | null> {
  if (!UUID_RE.test(askmiraTenantId)) return null;
  const [row] = await db
    .select({ link: askmiraLinks, workspace: { id: tenants.id, name: tenants.name, slug: tenants.slug } })
    .from(askmiraLinks)
    .innerJoin(tenants, eq(tenants.id, askmiraLinks.tenantId))
    .where(eq(askmiraLinks.askmiraTenantId, askmiraTenantId.toLowerCase()))
    .limit(1);
  return row ?? null;
}

/**
 * A token's claims, checked with the secret of the AskMiraa workspace it names
 * (`sub` on server-to-server calls, `tid` on a sign-in link), so one
 * workspace's secret can never act for another. A workspace that is not
 * connected gets a 404, as if these endpoints did not exist.
 */
export async function claimsOf(token: string, use: Use): Promise<Linked & { claims: Claims }> {
  const unverified = peek(token);
  const tenantId = String((use === 'launch' ? unverified?.tid : unverified?.sub) ?? '');
  const found = canConnect() ? await linkedTo(tenantId) : null;
  if (!found) throw httpError(404, 'Not found');
  const claims = verify(token, derive(found.link.tenantId, found.link.secretNonce));
  if (!claims) throw httpError(401, 'This AskMiraa link is not valid or has expired.');
  if (claims.use !== use) throw httpError(401, 'This AskMiraa link is not valid here.');
  return { ...found, claims };
}

/** AskMiraa's server-to-server call: the token, bound to this exact body and workspace. */
export async function assertion(req: Request, use: Exclude<Use, 'launch'>) {
  const raw = Buffer.from(await req.arrayBuffer());
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'The request is not JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'The request is not a JSON object.');
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!match) throw httpError(401, 'Missing AskMiraa assertion.');
  const found = await claimsOf(match[1]!.trim(), use);
  if (!safeEqual(String(found.claims.bh ?? ''), sha256hex(raw))) {
    throw httpError(401, 'The assertion does not match this request.');
  }
  if (String(body.tenant_id ?? '').toLowerCase() !== String(found.claims.sub).toLowerCase()) {
    throw httpError(401, 'The assertion is for another workspace.');
  }
  return { ...found, body };
}

/** A sign-in link or an action works once: a second use of its `jti` is refused. */
export async function spendOnce(claims: Claims, refusal: string) {
  if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.exp !== 'number') {
    throw httpError(401, refusal);
  }
  await db
    .delete(askmiraUsedTokens)
    .where(lt(askmiraUsedTokens.expiresAt, new Date(Date.now() - 5 * 60 * 1000)));
  const inserted = await db
    .insert(askmiraUsedTokens)
    .values({ jti: claims.jti.slice(0, 64), expiresAt: new Date(claims.exp * 1000) })
    .onConflictDoNothing()
    .returning({ jti: askmiraUsedTokens.jti });
  if (inserted.length === 0) throw httpError(401, refusal);
}

/* ── People ──────────────────────────────────────────────── */

export type Person = {
  userId: string;
  /** The workspace here (not AskMiraa's). */
  tenantId: string;
  email: string;
  name: string;
  role: MembershipRole;
};

export function displayName(u: { firstName: string | null; lastName: string | null; email: string }) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email;
}

/** A member of the workspace by email, with their role there, or null. */
export async function memberByEmail(tenantId: string, email: string) {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: memberships.role,
      status: memberships.status,
    })
    .from(users)
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.tenantId, tenantId)),
    )
    .where(eq(users.email, normEmail(email)))
    .limit(1);
  return row ?? null;
}

/**
 * The person AskMiraa is asking for, if they are an active member of the
 * connected workspace. Their role is their membership's, whatever AskMiraa says.
 */
export async function actorIn(found: Linked, actor: unknown): Promise<Person> {
  const given = actor && typeof actor === 'object' ? (actor as Record<string, unknown>) : {};
  const email = normEmail(given.email);
  const refusal = httpError(
    403,
    `You are not a member of ${found.workspace.name} in ${BRAND}. Ask your sales admin to invite you there.`,
  );
  if (!EMAIL_RE.test(email)) throw refusal;
  const member = await memberByEmail(found.link.tenantId, email);
  if (!member) throw refusal;
  if (member.status !== 'active') {
    throw httpError(403, `Your ${BRAND} access to ${found.workspace.name} has been switched off.`);
  }
  const [managed] = await db
    .select({ suspendedAt: askmiraPeople.suspendedAt })
    .from(askmiraPeople)
    .where(
      and(eq(askmiraPeople.tenantId, found.link.tenantId), eq(askmiraPeople.userId, member.userId)),
    )
    .limit(1);
  if (managed?.suspendedAt) {
    throw httpError(403, `Your ${BRAND} access to ${found.workspace.name} has been switched off.`);
  }
  return {
    userId: member.userId,
    tenantId: found.link.tenantId,
    email: member.email,
    name: displayName(member),
    role: member.role,
  };
}
