import 'server-only';

// Connecting this workspace to an AskMira workspace, like "Sign in with…".
//
// 1. AskMira's admin presses Connect there and lands on /connect/askmira here
//    with AskMira's workspace, where to come back to, a state and a PKCE
//    challenge.
// 2. An owner or admin of the workspace here, signed in, presses Allow
//    (`approve`): a one-time code bound to this workspace and to the challenge
//    goes back to AskMira in the browser.
// 3. AskMira's server swaps the code and the verifier — which only it holds —
//    for this workspace's own secret (`swap`).
//
// The secret reaches this one workspace only. Either side can disconnect:
// AskMira from its Connectors (`revoke`), an owner or admin here from the
// same page (`disconnect`).

import crypto from 'node:crypto';

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';

import { db } from '@/db';
import { askmiraConnectCodes, askmiraLinks, tenants } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { getCurrentMembership } from '@/lib/membership';
import { getCurrentTenant } from '@/lib/tenant';

import {
  BRAND,
  PRODUCT,
  UUID_RE,
  canConnect,
  clean,
  derive,
  httpError,
  sha256hex,
} from './core';

const CODE_LIFETIME_MS = 5 * 60 * 1000;
const CALLBACK_PATH = '/settings/connectors/callback';
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;

export type Admin = { userId: string; tenantId: string; tenantName: string; role: string };

/** The signed-in owner or admin of the active workspace making this request. */
export async function signedInAdmin(): Promise<Admin> {
  const { userId } = await auth();
  if (!userId) throw httpError(401, `Sign in to ${BRAND} first.`);
  const tenant = await getCurrentTenant();
  const membership = tenant ? await getCurrentMembership() : null;
  if (!tenant || !membership) throw httpError(401, `Choose a ${BRAND} workspace first.`);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw httpError(403, `Only an owner or admin of ${tenant.name} connects it to AskMira.`);
  }
  return { userId, tenantId: tenant.id, tenantName: tenant.name, role: membership.role };
}

/** The AskMira that is asking, from where it wants the answer sent; refuses anything odd. */
function askmiraCallback(redirectUri: unknown) {
  let url: URL;
  try {
    url = new URL(String(redirectUri ?? ''));
  } catch {
    throw httpError(422, 'That is not an AskMira connect link.');
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !local) ||
    url.pathname.replace(/\/+$/, '') !== CALLBACK_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw httpError(422, 'That is not an AskMira connect link.');
  }
  const allowed = String(process.env.ASKMIRA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (allowed.length && !allowed.includes(url.origin)) {
    throw httpError(403, `This AskMira is not one this ${BRAND} connects to.`);
  }
  return url;
}

/** This workspace, and the AskMira workspace it is connected to, if any. */
export async function connection(me: Admin) {
  const [link] = await db
    .select()
    .from(askmiraLinks)
    .where(eq(askmiraLinks.tenantId, me.tenantId))
    .limit(1);
  return {
    can_connect: canConnect(),
    workspace: { id: me.tenantId, name: me.tenantName },
    connected: Boolean(link),
    askmira_workspace_id: link?.askmiraTenantId ?? null,
    askmira_workspace: link?.askmiraName ?? null,
    askmira_origin: link?.askmiraOrigin ?? null,
    connected_at: link?.connectedAt?.toISOString() ?? null,
  };
}

/** Allow: a one-time code for AskMira, bound to this workspace. */
export async function approve(me: Admin, body: Record<string, unknown>) {
  if (!canConnect()) {
    throw httpError(409, 'Set AUTH_SECRET or ASKMIRA_LINK_SECRET (at least 32 characters) on this server first.');
  }
  const tenantId = String(body.tenant_id ?? '').toLowerCase();
  const challenge = String(body.challenge ?? '');
  const state = String(body.state ?? '');
  const name = clean(body.tenant_name);
  if (!UUID_RE.test(tenantId) || !PKCE_RE.test(challenge) || !state || state.length > 4000 || !name) {
    throw httpError(422, 'That is not an AskMira connect link.');
  }
  const callback = askmiraCallback(body.redirect_uri);

  const links = await db
    .select({ tenantId: askmiraLinks.tenantId, askmiraTenantId: askmiraLinks.askmiraTenantId })
    .from(askmiraLinks)
    .where(or(eq(askmiraLinks.tenantId, me.tenantId), eq(askmiraLinks.askmiraTenantId, tenantId)));
  if (links.some((l) => l.tenantId === me.tenantId && l.askmiraTenantId !== tenantId)) {
    throw httpError(409, `${me.tenantName} is already connected to another AskMira workspace. Disconnect it first.`);
  }
  if (links.some((l) => l.askmiraTenantId === tenantId && l.tenantId !== me.tenantId)) {
    throw httpError(409, `That AskMira workspace is already connected to another ${BRAND} workspace.`);
  }

  const code = crypto.randomBytes(32).toString('base64url');
  await db.delete(askmiraConnectCodes).where(lt(askmiraConnectCodes.expiresAt, new Date()));
  await db.insert(askmiraConnectCodes).values({
    codeHash: sha256hex(code),
    tenantId: me.tenantId,
    askmiraTenantId: tenantId,
    askmiraName: name,
    askmiraOrigin: callback.origin,
    challenge,
    approvedBy: me.userId,
    expiresAt: new Date(Date.now() + CODE_LIFETIME_MS),
  });
  console.log(`[AskMira] ${me.tenantName} approved a connection to workspace ${tenantId} at ${callback.origin}`);
  const query = new URLSearchParams({ code, state, product: PRODUCT });
  return { redirect_to: `${callback.origin}${CALLBACK_PATH}?${query}` };
}

/** AskMira's server swaps the code, and the verifier only it holds, for the secret. */
export async function swap(body: Record<string, unknown>) {
  const code = String(body.code ?? '');
  const verifier = String(body.verifier ?? '');
  const tenantId = String(body.tenant_id ?? '').toLowerCase();
  const refused = httpError(400, 'This connect code is not valid or has expired.');
  if (!code || code.length > 200 || !PKCE_RE.test(verifier)) throw refused;
  // One use, whatever happens next.
  const [row] = await db
    .update(askmiraConnectCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(askmiraConnectCodes.codeHash, sha256hex(code)),
        isNull(askmiraConnectCodes.usedAt),
        gt(askmiraConnectCodes.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!row) throw refused;
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  if (
    row.askmiraTenantId !== tenantId ||
    challenge.length !== row.challenge.length ||
    !crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(row.challenge))
  ) {
    throw refused;
  }
  const [workspace] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, row.tenantId))
    .limit(1);
  if (!workspace) throw refused;
  const clash = await db
    .select({ tenantId: askmiraLinks.tenantId, askmiraTenantId: askmiraLinks.askmiraTenantId })
    .from(askmiraLinks)
    .where(or(eq(askmiraLinks.tenantId, workspace.id), eq(askmiraLinks.askmiraTenantId, tenantId)));
  if (clash.some((l) => (l.tenantId === workspace.id) !== (l.askmiraTenantId === tenantId))) {
    throw httpError(409, `That AskMira workspace or this ${BRAND} workspace is already connected elsewhere.`);
  }
  const nonce = crypto.randomBytes(32).toString('base64url');
  await db
    .insert(askmiraLinks)
    .values({
      tenantId: workspace.id,
      askmiraTenantId: tenantId,
      askmiraName: row.askmiraName,
      askmiraOrigin: row.askmiraOrigin,
      secretNonce: nonce,
      connectedBy: row.approvedBy,
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: askmiraLinks.tenantId,
      set: {
        askmiraTenantId: tenantId,
        askmiraName: row.askmiraName,
        askmiraOrigin: row.askmiraOrigin,
        secretNonce: nonce,
        connectedBy: row.approvedBy,
        connectedAt: new Date(),
      },
    });
  console.log(`[AskMira] workspace ${workspace.id} connected to AskMira workspace ${tenantId}`);
  return {
    product: PRODUCT,
    brand: BRAND,
    secret: derive(workspace.id, nonce),
    external_ref: workspace.id,
    organization: workspace.name,
  };
}

/** AskMira disconnected: forget this workspace's secret here too. */
export async function revoke(askmiraTenantId: string) {
  await db.delete(askmiraLinks).where(eq(askmiraLinks.askmiraTenantId, askmiraTenantId.toLowerCase()));
  console.log(`[AskMira] AskMira workspace ${askmiraTenantId} disconnected`);
  return { disconnected: true };
}

/** Disconnect from this side: AskMira's secret for this workspace stops working at once. */
export async function disconnect(me: Admin) {
  await db.delete(askmiraLinks).where(eq(askmiraLinks.tenantId, me.tenantId));
  console.log(`[AskMira] ${me.tenantName} disconnected from AskMira by ${me.userId}`);
  return connection(me);
}
