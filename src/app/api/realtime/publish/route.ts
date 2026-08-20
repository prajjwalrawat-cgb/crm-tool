import { auth, clerkClient } from '@/lib/auth/server';
import { NextResponse, type NextRequest } from 'next/server';

import { db } from '@/db';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';
import { getCurrentTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Publish an ephemeral realtime event (viewing / typing) on behalf of
 * the calling user. No DB writes — the body is forwarded to
 * `publishRealtimeEvent` which goes through `pg_notify`.
 *
 * Authorization model: the route enforces tenant isolation by stamping
 * the active tenant id onto every event before publishing. Clients
 * cannot forge `tenantId` (we drop the one they sent).
 *
 * Accepted event kinds:
 *   - viewing.started / viewing.stopped
 *   - typing.started  / typing.stopped
 *
 * Other event kinds are rejected — DB-write events (deal.updated,
 * comment.created, ...) come from server actions, never this route.
 */

type Body =
  | {
      kind: 'viewing.started' | 'viewing.stopped';
      entity: { type: 'deal' | 'company' | 'contact'; id: string };
    }
  | {
      kind: 'typing.started' | 'typing.stopped';
      thread: { type: 'comment' | 'note' | 'email'; entityType: string; entityId: string };
    };

const ALLOWED_KINDS = new Set([
  'viewing.started',
  'viewing.stopped',
  'typing.started',
  'typing.stopped',
]);

export async function POST(request: NextRequest): Promise<Response> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, message: 'Unauthorized' }, { status: 401 });
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return NextResponse.json({ ok: false, message: 'No tenant' }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, message: 'Invalid JSON' }, { status: 400 });
  }

  if (!body?.kind || !ALLOWED_KINDS.has(body.kind)) {
    return NextResponse.json(
      { ok: false, message: 'Unsupported event kind' },
      { status: 400 },
    );
  }

  // Display info is only carried on the `.started` events — a `.stopped`
  // event is keyed by userId alone. `clerkClient()` is the local-auth shim,
  // so `getUser` is a real `users` table read, and this endpoint is hit on a
  // fixed heartbeat by every open entity page. Skipping the lookup on stop
  // events drops a DB round trip from a request that never used the result.
  const needsDisplayInfo =
    body.kind === 'viewing.started' || body.kind === 'typing.started';

  let displayName: string | null = null;
  let imageUrl: string | null = null;
  if (needsDisplayInfo) {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId).catch(() => null);
    displayName = user
      ? [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        user.primaryEmailAddress?.emailAddress ||
        null
      : null;
    imageUrl = user?.imageUrl ?? null;
  }

  try {
    if (body.kind === 'viewing.started') {
      await publishRealtimeEvent(db, {
        type: 'viewing.started',
        tenantId: tenant.id,
        userId,
        displayName,
        imageUrl,
        entity: body.entity,
      });
    } else if (body.kind === 'viewing.stopped') {
      await publishRealtimeEvent(db, {
        type: 'viewing.stopped',
        tenantId: tenant.id,
        userId,
        entity: body.entity,
      });
    } else if (body.kind === 'typing.started') {
      await publishRealtimeEvent(db, {
        type: 'typing.started',
        tenantId: tenant.id,
        userId,
        displayName,
        thread: body.thread,
      });
    } else if (body.kind === 'typing.stopped') {
      await publishRealtimeEvent(db, {
        type: 'typing.stopped',
        tenantId: tenant.id,
        userId,
        thread: body.thread,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        message: err instanceof Error ? err.message : 'Publish failed',
      },
      { status: 500 },
    );
  }
}
