import { NextResponse, type NextRequest } from 'next/server';

import { getCallScoped, logRecordingAccess } from '@/lib/telephony/service';
import { fetchStoredRecording } from '@/lib/telephony/storage';
import { withViewer } from '@/lib/telephony/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/calls/:id/recording — stream our stored copy.
 *
 * Access: reps their own calls, managers/admins/owners the workspace; anyone
 * else (including another tenant) gets 404, never a hint the call exists.
 * Range requests pass through to storage, so the audio player can seek.
 * Every request is written to call_recording_access. The provider URL and the
 * storage key/signed URL never appear in the response.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withViewer(async (viewer) => {
    const call = await getCallScoped(viewer.tenantId, viewer, id);
    if (!call || !call.recordingStorageKey) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const range = request.headers.get('range');
    await logRecordingAccess({ tenantId: viewer.tenantId, callId: id, userId: viewer.userId, range });

    const upstream = await fetchStoredRecording(call.recordingStorageKey, range);
    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json({ error: 'recording_unavailable' }, { status: 502 });
    }
    const headers = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('content-type')) headers.set('content-type', 'audio/mpeg');
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'private, no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}
