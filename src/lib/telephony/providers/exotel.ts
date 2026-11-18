import { safeEqual } from '../crypto';
import type { CallStatus } from '@/db/schema/telephony';

import type { NormalizedCallEvent, RawRequest, TelephonyAccountContext, TelephonyProvider } from '../types';
import { TelephonyError } from '../types';

/**
 * Exotel adapter. Field names and semantics come from
 * docs/telephony-provider-notes.md (written from Exotel's docs, not memory).
 *
 * Credentials (decrypted): { accountSid, apiKey, apiToken, subdomain? }
 *   subdomain: 'api.exotel.com' (Singapore, default) | 'api.in.exotel.com' (Mumbai)
 *
 * Mapping is defensive: keys are read case-insensitively, both the
 * StatusCallback (`From`/`To`) and Passthru (`CallFrom`/`CallTo`) shapes are
 * accepted, unknown fields are ignored and missing ones tolerated.
 */

type Bag = Record<string, unknown>;

/** Case-insensitive, first non-empty of several key names. */
function pick(bag: Bag, ...names: string[]): unknown {
  const lower = new Map(Object.entries(bag).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v !== undefined && v !== null && v !== '' && v !== 'null') return v;
  }
  return undefined;
}
const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null);
const int = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/**
 * Exotel timestamps are `YYYY-MM-DD HH:mm:ss` with no zone. Exotel India
 * reports in IST; Singapore accounts in SGT. We treat zone-less values as IST
 * (+05:30), the deployment default, and accept ISO strings with a zone as-is.
 */
export function parseExotelTime(v: unknown, assumeOffset = '+05:30'): Date | null {
  const s = str(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const d = new Date(`${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}${assumeOffset}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapStatus(raw: string | null, eventType: string | null, dialCallStatus: string | null, talk: number | null): CallStatus | null {
  const s = (raw ?? '').toLowerCase().replace(/_/g, '-');
  const ev = (eventType ?? '').toLowerCase();
  if (ev === 'answered') return 'answered';
  switch (s) {
    case 'queued':
    case 'initiated':
      return 'initiated';
    case 'ringing':
      return 'ringing';
    case 'in-progress':
    case 'answered':
      return 'answered';
    case 'completed':
      // Completed with zero talk time means the customer never picked up.
      return talk === 0 ? 'no_answer' : 'completed';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      break;
  }
  // Passthru after a Connect applet carries the second leg's result.
  switch ((dialCallStatus ?? '').toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'client-hangup':
    case 'incomplete':
    case 'voicemail':
      return 'missed';
    default:
      return null;
  }
}

function mapDirection(raw: string | null): 'outbound' | 'inbound' | null {
  const d = (raw ?? '').toLowerCase();
  if (d.startsWith('outbound') || d === 'outgoing') return 'outbound';
  if (d === 'inbound' || d === 'incoming') return 'inbound';
  return null;
}

export function parseExotelWebhook(body: unknown): NormalizedCallEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const bag = body as Bag;
  const providerCallId = str(pick(bag, 'CallSid', 'Sid', 'call_sid'));
  if (!providerCallId) return null;

  const legs = Array.isArray(pick(bag, 'Legs')) ? (pick(bag, 'Legs') as unknown[]) : [];
  const legBags = legs.filter((l): l is Bag => !!l && typeof l === 'object');
  const conversation = int(pick(bag, 'ConversationDuration', 'conversation_duration'));
  const talk = conversation ?? (legBags.length >= 2 ? int(pick(legBags[1]!, 'OnCallDuration')) : null);

  const status = mapStatus(
    str(pick(bag, 'Status', 'CallStatus', 'call_status')),
    str(pick(bag, 'EventType', 'event_type')),
    str(pick(bag, 'DialCallStatus')),
    talk,
  );
  // An event without a status we understand is still useful when it is a
  // Passthru inbound hit (the call is ringing at us right now).
  const direction = mapDirection(str(pick(bag, 'Direction', 'direction')));
  const effective: CallStatus | null = status ?? (direction === 'inbound' ? 'ringing' : null);
  if (!effective) return null;

  const from = str(pick(bag, 'CallFrom', 'From', 'from'));
  const to = str(pick(bag, 'CallTo', 'To', 'to'));
  const startedAt = parseExotelTime(pick(bag, 'StartTime', 'start_time', 'DateCreated'));
  const endedAt = parseExotelTime(pick(bag, 'EndTime', 'end_time'));
  const duration = int(pick(bag, 'Duration', 'duration', 'DialCallDuration'));
  const answeredAt =
    effective === 'answered' ? parseExotelTime(pick(bag, 'DateUpdated')) ?? null : null;

  return {
    providerCallId,
    direction,
    status: effective,
    from,
    to,
    startedAt,
    answeredAt,
    endedAt,
    durationSec: duration ?? (startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null),
    talkTimeSec: talk,
    recordingUrl: str(pick(bag, 'RecordingUrl', 'recording_url')),
    agentPhone: str(pick(bag, 'DialWhomNumber')),
    customData: str(pick(bag, 'CustomField', 'custom_field')),
  };
}

function creds(account: TelephonyAccountContext) {
  const c = account.credentials;
  const accountSid = c.accountSid ?? c.account_sid;
  const apiKey = c.apiKey ?? c.api_key;
  const apiToken = c.apiToken ?? c.api_token;
  if (!accountSid || !apiKey || !apiToken) {
    throw new TelephonyError('Exotel account is missing accountSid / apiKey / apiToken.', 'not_configured');
  }
  const subdomain = (c.subdomain || 'api.exotel.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return { accountSid, apiKey, apiToken, subdomain };
}

export const exotelProvider: TelephonyProvider = {
  name: 'exotel',

  async clickToCall({ account, agentPhone, customerPhone, callerId, record, statusCallbackUrl, customData }) {
    const { accountSid, apiKey, apiToken, subdomain } = creds(account);
    const form = new URLSearchParams();
    form.set('From', agentPhone);
    form.set('To', customerPhone);
    form.set('CallerId', callerId);
    form.set('CallType', 'trans');
    form.set('Record', record ? 'true' : 'false');
    form.set('CustomField', customData.callId);
    form.set('StatusCallback', statusCallbackUrl);
    form.append('StatusCallbackEvents[0]', 'answered');
    form.append('StatusCallbackEvents[1]', 'terminal');
    form.set('StatusCallbackContentType', 'application/json');

    const res = await fetch(`https://${subdomain}/v1/Accounts/${encodeURIComponent(accountSid)}/Calls/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg =
        (json as { RestException?: { Message?: string } } | null)?.RestException?.Message ?? `HTTP ${res.status}`;
      throw new TelephonyError(`Exotel refused the call: ${msg}`, 'provider_error');
    }
    const sid = str((json as { Call?: Bag } | null)?.Call ? pick((json as { Call: Bag }).Call, 'Sid') : undefined);
    if (!sid) throw new TelephonyError('Exotel returned no call id.', 'provider_error');
    return { providerCallId: sid };
  },

  verifyWebhook(req: RawRequest, account: TelephonyAccountContext): boolean {
    // Exotel signs nothing (see notes). The secret rides in the callback URL.
    const url = new URL(req.url);
    const given = url.searchParams.get('s') ?? req.headers.get('x-saleinx-token') ?? '';
    if (!given || !safeEqual(given, account.webhookSecret)) return false;
    const allow = (process.env.EXOTEL_WEBHOOK_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length > 0 && (!req.ip || !allow.includes(req.ip))) return false;
    return true;
  },

  parseWebhook: parseExotelWebhook,

  async fetchRecording(url: string, account: TelephonyAccountContext) {
    let res = await fetch(url);
    if (res.status === 401 || res.status === 403) {
      const { apiKey, apiToken } = creds(account);
      res = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiToken}`).toString('base64')}` } });
    }
    if (!res.ok || !res.body) throw new TelephonyError(`Recording not available yet (HTTP ${res.status})`, 'provider_error');
    return { body: res.body, contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
  },
};
