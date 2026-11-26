import 'server-only';

import { runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

import { getMapsProvider, type MapsProvider } from './maps';
import { FieldError, type FieldActor } from './types';

/**
 * Plumbing shared by the meeting service files (meetings, checkins, outcomes, day).
 * Not part of the public contract.
 */

export type FieldDeps = { maps?: MapsProvider; now?: () => Date };
export type Tx = Parameters<Parameters<typeof tenantTransaction>[0]>[0];

export const nowOf = (deps?: FieldDeps): Date => (deps?.now ?? (() => new Date()))();
export const mapsOf = (deps?: FieldDeps): MapsProvider => deps?.maps ?? getMapsProvider();

/** Run `fn` under the actor's tenant context, so RLS always matches the actor's tenant. */
export function asActor<T>(actor: FieldActor, fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenantId: actor.tenantId, userId: actor.userId }, fn);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export type Position = { lat: number; lng: number; accuracyM: number };

export function validatePosition(pos: Position): Position {
  const ok =
    pos != null &&
    Number.isFinite(pos.lat) &&
    Number.isFinite(pos.lng) &&
    Math.abs(pos.lat) <= 90 &&
    Math.abs(pos.lng) <= 180 &&
    Number.isFinite(pos.accuracyM) &&
    pos.accuracyM >= 0;
  if (!ok) throw new FieldError('validation', 'A valid position (lat, lng, accuracyM) is required');
  return { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM };
}

/** Trimmed text or null; throws `validation` when longer than `max`. */
export function optText(v: string | null | undefined, field: string, max = 5000): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new FieldError('validation', `${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new FieldError('validation', `${field} is too long (max ${max})`);
  return t || null;
}

export async function publishMeetingUpdated(
  tx: Tx,
  m: { tenantId: string; id: string; ownerId: string },
): Promise<void> {
  await publishRealtimeEvent(tx, { type: 'meeting.updated', tenantId: m.tenantId, meetingId: m.id, ownerId: m.ownerId });
}
