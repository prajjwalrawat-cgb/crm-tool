import { auth, clerkClient } from '@/lib/auth/server';
import { type NextRequest, NextResponse } from 'next/server';

import { client as pgClient } from '@/db';
import {
  adjustGauge,
  captureError,
  incr,
  logger,
  observe,
  runWithTrace,
} from '@/lib/observability';
import {
  type RealtimeEnvelope,
  tenantChannel,
} from '@/lib/realtime/events';
import {
  getPresenceSnapshot,
  trackPresence,
  untrackPresence,
} from '@/lib/realtime/presence';
import { envelopesSince, recordEnvelope } from '@/lib/realtime/replay';
import { getCurrentTenant } from '@/lib/tenant';

// Force Node runtime: we hold a long-lived Postgres LISTEN connection per
// SSE client, which the Edge runtime can't sustain.
export const runtime = 'nodejs';

// Don't try to cache or pre-render an event stream.
export const dynamic = 'force-dynamic';

// Platform ceiling for a single connection. Backstops the absolute lifetime
// cap below so a function instance can never run unbounded on Vercel.
//
// 300 is the maximum the Hobby plan accepts — the builder REJECTS the whole
// deployment (not just this route) for anything higher, so this is a hard
// deploy-time constraint, not a soft limit. Keep it >= MAX_STREAM_MS below,
// so our own clean teardown always fires first and the platform ceiling is
// only ever a backstop. If the plan changes, both numbers can rise together.
export const maxDuration = 300;

// Absolute lifetime cap for one SSE connection. When it fires we close the
// stream cleanly; the browser's EventSource auto-reconnects and the server
// replays anything missed via Last-Event-ID. Without this, a client that
// dies uncleanly (laptop sleep, network drop, browser crash) never triggers
// `request.signal.aborted`, so its LISTEN connection + instance memory would
// stay provisioned forever — the main driver of leaked GB-Hours.
//
// 4 min is long enough that an actively-used tab rarely cycles (avoiding
// reconnect churn: Clerk lookups, new LISTEN connections, presence
// re-broadcasts) yet short enough to reclaim genuinely-leaked instances
// quickly. Keep it under the platform's function-duration ceiling so the
// clean teardown + replay runs instead of a hard kill.
const MAX_STREAM_MS = 4 * 60 * 1000;

/**
 * Server-Sent Events stream of realtime tenant events.
 *
 * Per request:
 *   1. Authenticate via Clerk; resolve the user's active tenant.
 *   2. Open a `LISTEN tenant:<tenantId>` subscription on a postgres-js
 *      sql instance; postgres-js reserves a dedicated connection for it.
 *   3. Track this user in the in-memory presence registry; broadcast a
 *      `presence.snapshot` to other listeners on the channel.
 *   4. Stream every NOTIFY payload to the client as an SSE `data:` frame.
 *   5. On client disconnect (`request.signal.aborted`), unlisten + untrack
 *      + broadcast the updated presence.
 *
 * Heartbeat comments (`: keepalive`) every 25s prevent intermediate proxies
 * (Vercel, Cloudflare, nginx) from killing the idle stream.
 */
export async function GET(request: NextRequest): Promise<Response> {
  return await runWithTrace(
    { origin: 'sse', name: 'realtime.events' },
    () => handleSseConnection(request),
  );
}

async function handleSseConnection(request: NextRequest): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    incr('sse.unauthenticated');
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    incr('sse.no_tenant');
    return new NextResponse('No active tenant', { status: 403 });
  }

  // Resolve the user's display info once for presence broadcasts. Better
  // than passing the bare userId — clients render avatars without a follow
  // -up Clerk fetch.
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId).catch(() => null);
  const displayName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.primaryEmailAddress?.emailAddress ||
      userId
    : userId;
  const imageUrl = user?.imageUrl ?? null;

  const channel = tenantChannel(tenant.id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let listenHandle: { unlisten: () => Promise<void> } | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let lifetimeCap: ReturnType<typeof setTimeout> | null = null;
      const openedAt = Date.now();
      adjustGauge('sse.connections', 1);
      adjustGauge('sse.connections', 1, { tenantId: tenant.id });
      incr('sse.opens', 1, { tenantId: tenant.id });
      logger.info('sse.connection opened', {
        tenantId: tenant.id,
        userId,
      });

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Controller already closed; ignore.
        }
      };

      const sendData = (data: string, envelopeId?: string) => {
        // Multi-line payloads must be prefixed per SSE spec; JSON is
        // single-line so a single `data:` frame is fine.
        //
        // We prefix each frame with `id: <envelopeId>` when available
        // so the native EventSource client tracks it as `lastEventId`
        // and sends it back in the `Last-Event-ID` header on reconnect.
        // The server-side replay buffer (src/lib/realtime/replay.ts)
        // uses that id to ship missed envelopes.
        if (envelopeId) {
          safeEnqueue(encoder.encode(`id: ${envelopeId}\n`));
        }
        safeEnqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // `silentPresence` skips the presence "left" broadcast — used when the
      // teardown is our own lifetime cap (the client reconnects immediately),
      // not a genuine disconnect. Avoids offline→online flicker on every cycle.
      const cleanup = async (opts: { silentPresence?: boolean } = {}) => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetimeCap) clearTimeout(lifetimeCap);
        try {
          if (listenHandle) await listenHandle.unlisten();
        } catch (err) {
          captureError(err, {
            category: 'realtime.unlisten',
            severity: 'medium',
            retryable: true,
            fields: { tenantId: tenant.id, userId },
          });
        }
        try {
          await untrackPresence(tenant.id, userId, {
            notify: !opts.silentPresence,
          });
        } catch (err) {
          captureError(err, {
            category: 'realtime.untrack_presence',
            severity: 'medium',
            retryable: true,
            fields: { tenantId: tenant.id, userId },
          });
        }
        adjustGauge('sse.connections', -1);
        adjustGauge('sse.connections', -1, { tenantId: tenant.id });
        observe('sse.connection_lifetime_ms', Date.now() - openedAt);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Hook abort first so any synchronous failure during setup still
      // tears down cleanly.
      request.signal.addEventListener('abort', () => {
        void cleanup();
      });

      try {
        // Replay events the client missed while disconnected. Native
        // EventSource sends its tracked last id as the `Last-Event-ID`
        // header on reconnect — we use it to slice the per-process ring.
        const lastEventId = request.headers.get('last-event-id');
        const missed = envelopesSince(tenant.id, lastEventId);
        if (missed.length > 0) {
          incr('realtime.replayed', missed.length, { tenantId: tenant.id });
          for (const env of missed) {
            sendData(JSON.stringify(env), env.id);
          }
        }

        // Send the current presence snapshot up-front so the UI doesn't
        // have to wait for a NOTIFY round-trip on first paint.
        const initialPresence: RealtimeEnvelope = {
          id: crypto.randomUUID(),
          emittedAt: new Date().toISOString(),
          event: {
            type: 'presence.snapshot',
            tenantId: tenant.id,
            members: getPresenceSnapshot(tenant.id),
          },
        };
        sendData(JSON.stringify(initialPresence), initialPresence.id);

        // Subscribe to the tenant channel. The callback fires for every
        // pg_notify on this channel for the lifetime of the connection.
        listenHandle = await pgClient.listen(channel, (payload) => {
          incr('realtime.events_dispatched', 1, { tenantId: tenant.id });
          // Parse to capture envelope id; the ring buffer needs structured
          // data and the SSE frame needs the id for client lastEventId
          // tracking. Malformed payloads are stamped without an id and
          // skip the buffer.
          try {
            const env = JSON.parse(payload) as RealtimeEnvelope;
            recordEnvelope(env);
            sendData(payload, env.id);
          } catch {
            sendData(payload);
          }
        });

        // Track this user in presence and broadcast the snapshot to others.
        await trackPresence(tenant.id, {
          userId,
          displayName,
          imageUrl,
        });

        // Keepalive: 25s undercuts most proxy idle timeouts (~30-60s).
        heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(': keepalive\n\n'));
        }, 25000);

        // Absolute lifetime cap — force a clean teardown so no connection
        // (including uncleanly-dropped ones) holds an instance indefinitely.
        // EventSource reconnects and replays via Last-Event-ID. Presence is
        // torn down silently: the client is about to reconnect, so a "left"
        // broadcast would only flicker the user for other members.
        lifetimeCap = setTimeout(() => {
          void cleanup({ silentPresence: true });
        }, MAX_STREAM_MS);
      } catch (err) {
        console.error('[realtime] setup failed:', err);
        await cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable buffering on Vercel / nginx-style proxies.
      'X-Accel-Buffering': 'no',
    },
  });
}
