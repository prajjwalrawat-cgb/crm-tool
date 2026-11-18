import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { safeEqual } from '../crypto';
import type { CallStatus } from '@/db/schema/telephony';

import type { NormalizedCallEvent, RawRequest, TelephonyAccountContext, TelephonyProvider } from '../types';

/**
 * In-memory provider for tests and local demos. `clickToCall` records the
 * request and returns a fake call id; tests then feed webhook bodies of the
 * shape below through the real webhook pipeline.
 *
 *   { callId, status, from?, to?, direction?, talkTimeSec?, recordingUrl?, customData?, at? }
 */
export const mockCalls: Array<{ providerCallId: string; agentPhone: string; customerPhone: string; customData: string }> = [];

const STATUSES = new Set<CallStatus>(['initiated', 'ringing', 'answered', 'completed', 'no_answer', 'busy', 'failed', 'missed']);

export const mockProvider: TelephonyProvider = {
  name: 'mock',
  async clickToCall({ agentPhone, customerPhone, customData }) {
    const providerCallId = `mock-${randomUUID()}`;
    mockCalls.push({ providerCallId, agentPhone, customerPhone, customData: customData.callId });
    return { providerCallId };
  },
  verifyWebhook(req: RawRequest, account: TelephonyAccountContext) {
    const given = new URL(req.url).searchParams.get('s') ?? req.headers.get('x-saleinx-token') ?? '';
    return !!given && safeEqual(given, account.webhookSecret);
  },
  parseWebhook(body: unknown): NormalizedCallEvent | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const status = String(b.status ?? '') as CallStatus;
    if (typeof b.callId !== 'string' || !STATUSES.has(status)) return null;
    const at = typeof b.at === 'string' ? new Date(b.at) : new Date();
    return {
      providerCallId: b.callId,
      direction: b.direction === 'inbound' ? 'inbound' : b.direction === 'outbound' ? 'outbound' : null,
      status,
      from: typeof b.from === 'string' ? b.from : null,
      to: typeof b.to === 'string' ? b.to : null,
      startedAt: status === 'ringing' || status === 'initiated' ? at : null,
      answeredAt: status === 'answered' ? at : null,
      endedAt: ['completed', 'no_answer', 'busy', 'failed', 'missed'].includes(status) ? at : null,
      durationSec: typeof b.durationSec === 'number' ? b.durationSec : null,
      talkTimeSec: typeof b.talkTimeSec === 'number' ? b.talkTimeSec : null,
      recordingUrl: typeof b.recordingUrl === 'string' ? b.recordingUrl : null,
      agentPhone: typeof b.agentPhone === 'string' ? b.agentPhone : null,
      customData: typeof b.customData === 'string' ? b.customData : null,
    };
  },
  async fetchRecording() {
    // ~1 KB of silence-ish bytes: enough for storage + range tests.
    return { body: Readable.from([Buffer.alloc(1024, 0xff)]), contentType: 'audio/mpeg' };
  },
};
