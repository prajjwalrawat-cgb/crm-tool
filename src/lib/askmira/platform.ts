import 'server-only';

// AskMiraa's platform sets a company up here (AskMiraa → Platform → Tools).
//
// AskMiraa's super admin holds a key for Saleinx, the same value as this
// server's ASKMIRA_PLATFORM_SECRET. With it — never with a workspace's own
// secret — AskMiraa may:
//
//   POST /api/integrations/askmira/platform/ping           check the key
//   POST /api/integrations/askmira/platform/organizations  find a workspace here
//   POST /api/integrations/askmira/platform/provision      create or attach one
//
// `provision` creates a workspace for the company with AskMiraa's admin as its
// owner (a new login here when the email has none; they come in from AskMiraa,
// or set a password with "Forgot password"), or attaches the workspace the
// super admin picked. It answers with that workspace's own secret, exactly as
// Allow does (connect.ts), so every later call is checked with it.
//
// It never makes a second workspace for someone who already owns or runs one
// unasked: it answers 409 "existing" naming them, and AskMiraa's super admin
// links that one or says "create_new". Attaching an existing workspace grants
// nobody a role: the people sync links members by email, as always.

import crypto from 'node:crypto';

import { and, eq, ilike, inArray, or } from 'drizzle-orm';

import { db } from '@/db';
import { askmiraLinks, memberships, tenants, users } from '@/db/schema';
import { createUser, getUserByEmail } from '@/lib/auth/users';
import { createTenant } from '@/lib/tenant';

import {
  BRAND,
  EMAIL_RE,
  PRODUCT,
  UUID_RE,
  canConnect,
  clean,
  derive,
  httpError,
  normEmail,
  safeEqual,
  sha256hex,
  spendOnce,
  verify,
} from './core';

const RUNS = ['owner', 'admin'] as const;

function platformKey() {
  return process.env.ASKMIRA_PLATFORM_SECRET ?? '';
}

/** The platform's call: signed with the platform key, use=platform, bound to this body. */
export async function platformAssertion(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  const key = platformKey();
  // Not set up for it: as if these endpoints did not exist.
  if (key.length < 32) throw httpError(404, 'Not found');
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!match) throw httpError(401, 'Missing AskMiraa assertion.');
  const token = match[1]!.trim();
  const claims = verify(token, key);
  if (!claims || claims.use !== 'platform' || claims.sub !== 'platform') {
    throw httpError(401, 'This AskMiraa platform key is not the one set here.');
  }
  if (!safeEqual(String(claims.bh ?? ''), sha256hex(raw))) {
    throw httpError(401, 'The assertion does not match this request.');
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'The request is not JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'The request is not a JSON object.');
  }
  return { claims, body };
}

export function ping() {
  return {
    product: PRODUCT,
    brand: BRAND,
    ready: canConnect(),
    message: canConnect()
      ? `${BRAND} is ready.`
      : `Set AUTH_SECRET or ASKMIRA_LINK_SECRET (at least 32 characters) on ${BRAND} first.`,
  };
}

type Org = { ref: string; name: string; admins: string[]; connected_to: string | null };

/** The owners and admins of each workspace, and what it is connected to. */
async function describe(ids: string[]): Promise<Org[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(inArray(tenants.id, ids));
  const people = await db
    .select({ tenantId: memberships.tenantId, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        inArray(memberships.tenantId, ids),
        inArray(memberships.role, [...RUNS]),
        eq(memberships.status, 'active'),
      ),
    );
  const links = await db
    .select({ tenantId: askmiraLinks.tenantId, askmira: askmiraLinks.askmiraTenantId })
    .from(askmiraLinks)
    .where(inArray(askmiraLinks.tenantId, ids));
  return rows.map((row) => ({
    ref: row.id,
    name: row.name,
    admins: people.filter((p) => p.tenantId === row.id).map((p) => p.email).slice(0, 5),
    connected_to: links.find((l) => l.tenantId === row.id)?.askmira ?? null,
  }));
}

/** Workspaces whose name or address matches, or whose owner or admin's email does. */
export async function organizations(body: Record<string, unknown>) {
  const q = clean(body.q, 120);
  if (!q || q.length < 2) throw httpError(422, 'Type at least two letters.');
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const byName = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(or(ilike(tenants.name, like), ilike(tenants.slug, like)))
    .limit(20);
  const byPerson = await db
    .select({ id: memberships.tenantId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(ilike(users.email, like), inArray(memberships.role, [...RUNS])))
    .limit(20);
  const ids = [...new Set([...byName, ...byPerson].map((r) => r.id))].slice(0, 20);
  return { organizations: await describe(ids) };
}

/** Connect this workspace to that AskMiraa workspace: a fresh nonce, so a fresh secret. */
async function connect(
  workspace: { id: string; name: string },
  askmira: { id: string; name: string | null; origin: string | null },
) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  // One AskMiraa workspace per workspace here, and the other way round.
  await db.delete(askmiraLinks).where(eq(askmiraLinks.askmiraTenantId, askmira.id));
  await db
    .insert(askmiraLinks)
    .values({
      tenantId: workspace.id,
      askmiraTenantId: askmira.id,
      askmiraName: askmira.name,
      askmiraOrigin: askmira.origin,
      secretNonce: nonce,
      connectedBy: 'askmira-platform',
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: askmiraLinks.tenantId,
      set: {
        askmiraTenantId: askmira.id,
        askmiraName: askmira.name,
        askmiraOrigin: askmira.origin,
        secretNonce: nonce,
        connectedBy: 'askmira-platform',
        connectedAt: new Date(),
      },
    });
  return derive(workspace.id, nonce);
}

function origin(value: unknown): string | null {
  try {
    const url = new URL(String(value ?? ''));
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function splitName(name: string | null, email: string) {
  const text = (name ?? '').trim() || email.split('@')[0]!;
  const [first, ...rest] = text.split(/\s+/);
  return { firstName: first ?? null, lastName: rest.join(' ') || null };
}

export async function provision(body: Record<string, unknown>, claims: Record<string, unknown>) {
  // A captured request can't be sent again to swap the key AskMiraa holds.
  await spendOnce(claims, 'This request was already carried out.');
  if (!canConnect()) {
    throw httpError(409, `Set AUTH_SECRET or ASKMIRA_LINK_SECRET (at least 32 characters) on ${BRAND} first.`);
  }
  const askmiraId = String(body.tenant_id ?? '').toLowerCase();
  const company = (body.company && typeof body.company === 'object' ? body.company : {}) as Record<string, unknown>;
  const admin = (body.admin && typeof body.admin === 'object' ? body.admin : {}) as Record<string, unknown>;
  const name = clean(company.name, 200) ?? clean(body.tenant_name, 200);
  const email = normEmail(admin.email);
  const ref = clean(body.organization_ref, 120);
  if (!UUID_RE.test(askmiraId) || !name || !EMAIL_RE.test(email)) {
    throw httpError(422, 'AskMiraa sent an incomplete company.');
  }
  const askmira = { id: askmiraId, name: clean(body.tenant_name, 200) ?? name, origin: origin(body.askmira_origin) };

  // Attach the workspace the super admin picked.
  if (ref) {
    if (!UUID_RE.test(ref)) throw httpError(404, `No such workspace in ${BRAND}.`);
    const [workspace] = await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ref))
      .limit(1);
    if (!workspace) throw httpError(404, `No such workspace in ${BRAND}.`);
    const [link] = await db.select().from(askmiraLinks).where(eq(askmiraLinks.tenantId, workspace.id)).limit(1);
    if (link && link.askmiraTenantId !== askmiraId) {
      throw httpError(409, `${workspace.name} is connected to another AskMiraa workspace.`, { code: 'taken' });
    }
    const secret = await connect(workspace, askmira);
    console.log(`[AskMiraa] platform attached ${workspace.name} to AskMiraa workspace ${askmiraId}`);
    return answer(workspace, secret, { created: false, adminCreated: false });
  }

  // Already connected here (AskMiraa lost its key, or asked twice): the same workspace, a new key.
  const [linked] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(askmiraLinks)
    .innerJoin(tenants, eq(tenants.id, askmiraLinks.tenantId))
    .where(eq(askmiraLinks.askmiraTenantId, askmiraId))
    .limit(1);
  if (linked) {
    const secret = await connect(linked, askmira);
    return answer(linked, secret, { created: false, adminCreated: false });
  }

  let user = await getUserByEmail(email);
  if (user && body.create_new !== true) {
    const runs = await db
      .select({ id: memberships.tenantId })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          inArray(memberships.role, [...RUNS]),
          eq(memberships.status, 'active'),
        ),
      );
    if (runs.length > 0) {
      throw httpError(
        409,
        `${email} already runs ${runs.length === 1 ? 'a workspace' : `${runs.length} workspaces`} in ${BRAND}.`,
        { code: 'existing', organizations: await describe(runs.map((r) => r.id).slice(0, 10)) },
      );
    }
  }
  let adminCreated = false;
  if (!user) {
    user = await createUser({ email, ...splitName(clean(admin.name, 200), email) });
    adminCreated = true;
  }
  const workspace = await createTenant({ name, ownerUserId: user.id });
  const secret = await connect(workspace, askmira);
  console.log(`[AskMiraa] platform created ${workspace.name} for AskMiraa workspace ${askmiraId}, owner ${email}`);
  return answer(workspace, secret, { created: true, adminCreated });
}

function answer(
  workspace: { id: string; name: string },
  secret: string,
  { created, adminCreated }: { created: boolean; adminCreated: boolean },
) {
  return {
    product: PRODUCT,
    brand: BRAND,
    secret,
    external_ref: workspace.id,
    organization: workspace.name,
    created,
    admin_created: adminCreated,
  };
}
