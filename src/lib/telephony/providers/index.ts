import type { TelephonyProviderName } from '@/db/schema/telephony';

import { NotImplementedError, type TelephonyProvider } from '../types';
import { exotelProvider } from './exotel';
import { mockProvider } from './mock';

/**
 * Provider registry. Only Exotel (and the test mock) are implemented; the
 * rest are wired so accounts can be stored, and fail loudly on use. Before
 * implementing one, read its current docs and add a section to
 * docs/telephony-provider-notes.md — do not code field names from memory.
 */
function notImplemented(name: TelephonyProviderName): TelephonyProvider {
  const fail = (what: string) => {
    throw new NotImplementedError(`${name} ${what}`);
  };
  return {
    name,
    clickToCall: async () => fail('click-to-call'),
    verifyWebhook: () => fail('webhook verification'),
    parseWebhook: () => fail('webhook parsing'),
  };
}

export const providers: Record<TelephonyProviderName, TelephonyProvider> = {
  exotel: exotelProvider,
  mock: mockProvider,
  knowlarity: notImplemented('knowlarity'),
  ozonetel: notImplemented('ozonetel'),
  myoperator: notImplemented('myoperator'),
  twilio: notImplemented('twilio'),
};

export const IMPLEMENTED_PROVIDERS: TelephonyProviderName[] = ['exotel'];

export function getProvider(name: TelephonyProviderName): TelephonyProvider {
  const p = providers[name];
  if (!p) throw new NotImplementedError(`provider ${name}`);
  return p;
}
