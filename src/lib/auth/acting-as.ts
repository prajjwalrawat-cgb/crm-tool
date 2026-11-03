import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

import type { SessionClaims } from './jwt';

/**
 * Who a server-to-server request acts as, when it is not a browser session.
 *
 * AskMira's assistant does things here for one person (src/lib/askmira): it
 * creates their lead, moves their deal. Rather than a second copy of every
 * rule, the request runs the app's own server actions — `createDealAction`,
 * `updateDealStageAction` and the rest — as that person. `getSessionClaims`
 * reads this first, so `auth()`, `checkPermission()` and the membership and
 * role checks behind them answer exactly as they would for that person's own
 * session.
 *
 * Only `runAsPerson` sets it, and only src/lib/askmira/actions.ts calls that,
 * after checking AskMira's signed request and the person's active membership
 * of the connected workspace. Nothing a browser sends can reach it.
 */

const store = new AsyncLocalStorage<SessionClaims>();

export function actingAs(): SessionClaims | undefined {
  return store.getStore();
}

export async function runAsPerson<T>(claims: SessionClaims, fn: () => Promise<T>): Promise<T> {
  return await store.run({ sub: claims.sub, tid: claims.tid }, fn);
}
