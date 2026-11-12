import 'server-only';

// The AskMiraa endpoints, one function per route (src/app/api/integrations/askmira/…).
// Kept here so they can be exercised without a running server.

import { ACTIONS } from './actions';
import { approve, connection, disconnect, revoke, signedInAdmin, swap } from './connect';
import { actorIn, assertion, httpError, paramsOf, respond, spendOnce } from './core';
import { launch } from './launch';
import { organizations, ping, platformAssertion, provision } from './platform';
import { syncPeople } from './people';
import { actorOf, QUERIES } from './queries';

async function jsonOf(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

/** POST users/sync — the company's people (use=provision). */
export const syncRoute = (req: Request) =>
  respond(async () => {
    const { body, ...found } = await assertion(req, 'provision');
    return syncPeople(found, body);
  });

/** POST query — read for one person (use=query). */
export const queryRoute = (req: Request) =>
  respond(async () => {
    const { body, ...found } = await assertion(req, 'query');
    const kind = String(body.kind ?? '');
    const answer = Object.hasOwn(QUERIES, kind) ? QUERIES[kind] : null;
    if (!answer) throw httpError(422, 'Unknown query.');
    const me = await actorIn(found, body.actor);
    return { kind, actor: actorOf(me), ...(await answer({ found, me, params: paramsOf(body) })) };
  });

/** POST act — a change, as one person (use=act, each token once). */
export const actRoute = (req: Request) =>
  respond(async () => {
    const { body, claims, ...found } = await assertion(req, 'act');
    const kind = String(body.kind ?? '');
    const action = Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind] : null;
    if (!action) throw httpError(422, 'Unknown action.');
    await spendOnce(claims, 'This request was already carried out.');
    const me = await actorIn(found, body.actor);
    const result = await action({ found, me, params: paramsOf(body) });
    console.log(`[AskMiraa] ${kind} by ${me.email} in ${found.workspace.name}`);
    return { kind, actor: actorOf(me), ...result };
  });

/** POST connect/token — AskMiraa's server swaps the one-time code (no token yet: PKCE). */
export const tokenRoute = (req: Request) => respond(async () => swap(await jsonOf(req)));

/** POST connect/revoke — AskMiraa disconnected (use=revoke). */
export const revokeRoute = (req: Request) =>
  respond(async () => {
    const { claims } = await assertion(req, 'revoke');
    return revoke(String(claims.sub));
  });

/** POST connect/approve — Allow, by a signed-in owner or admin. */
export const approveRoute = (req: Request) =>
  respond(async () => approve(await signedInAdmin(), await jsonOf(req)));

/** GET connection — this workspace and what it is connected to. */
export const connectionRoute = () => respond(async () => connection(await signedInAdmin()));

/** DELETE connection — disconnect from this side. */
export const disconnectRoute = () => respond(async () => disconnect(await signedInAdmin()));

/** POST launch — the sign-in page hands over AskMiraa's link (use=launch, once). */
export const launchRoute = (req: Request) =>
  respond(async () => {
    const body = await jsonOf(req);
    const token = String(body.token ?? '');
    if (!token || token.length > 4000) throw httpError(401, 'This AskMiraa link is not valid.');
    return launch(token, body.next);
  });

/** POST platform/{ping,organizations,provision} — AskMiraa's platform (use=platform). */
export const platformRoute = (req: Request, action: string) =>
  respond(async () => {
    const { body, claims } = await platformAssertion(req);
    if (action === 'ping') return ping();
    if (action === 'organizations') return organizations(body);
    if (action === 'provision') return provision(body, claims);
    throw httpError(404, 'Not found');
  });
