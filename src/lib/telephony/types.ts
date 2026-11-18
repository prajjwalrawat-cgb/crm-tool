import type { Readable } from 'node:stream';

import type { CallStatus, TelephonyProviderName } from '@/db/schema/telephony';

/**
 * Provider-agnostic telephony adapter. One implementation per provider in
 * ./providers; the registry in ./providers/index.ts maps a provider name to
 * its instance. Exotel is implemented; the others throw NotImplementedError.
 */

/** Decrypted account handed to adapters. Credentials never leave the server. */
export type TelephonyAccountContext = {
  id: string;
  tenantId: string;
  provider: TelephonyProviderName;
  credentials: Record<string, string>;
  virtualNumbers: string[];
  webhookSecret: string;
};

/** What the webhook route hands an adapter: everything it might need to verify. */
export type RawRequest = {
  url: string;
  method: string;
  headers: Headers;
  rawBody: string;
  /** Client IP as seen by the platform (first x-forwarded-for hop). */
  ip: string | null;
};

/** One provider event mapped onto our vocabulary. Unknown fields are dropped. */
export type NormalizedCallEvent = {
  providerCallId: string;
  direction: 'outbound' | 'inbound' | null;
  status: CallStatus;
  from: string | null;
  to: string | null;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  talkTimeSec: number | null;
  recordingUrl: string | null;
  /** The agent leg's number, when the provider tells us. */
  agentPhone: string | null;
  /** Our calls.id, echoed back from click-to-call (Exotel CustomField). */
  customData: string | null;
};

export interface TelephonyProvider {
  readonly name: TelephonyProviderName;
  clickToCall(args: {
    account: TelephonyAccountContext;
    agentPhone: string;
    customerPhone: string;
    callerId: string;
    record: boolean;
    statusCallbackUrl: string;
    customData: { callId: string; tenantId: string };
  }): Promise<{ providerCallId: string }>;
  /** Signature or shared-secret check; constant time. */
  verifyWebhook(req: RawRequest, account: TelephonyAccountContext): boolean;
  /** Defensive: returns null for payloads that are not call events. */
  parseWebhook(body: unknown): NormalizedCallEvent | null;
  fetchRecording?(url: string, account: TelephonyAccountContext): Promise<{ body: Readable | ReadableStream<Uint8Array>; contentType: string }>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export class TelephonyError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_configured'
      | 'no_agent_phone'
      | 'dnc'
      | 'outside_hours'
      | 'not_owner'
      | 'invalid_number'
      | 'provider_error'
      | 'not_found',
  ) {
    super(message);
    this.name = 'TelephonyError';
  }
}
