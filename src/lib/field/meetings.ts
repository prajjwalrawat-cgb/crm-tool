import 'server-only';

import { and, eq } from 'drizzle-orm';

import { companies, contacts, deals, meetings, type Company, type Meeting } from '@/db/schema';
import type { GeocodeStatus } from '@/db/schema/enums';
import { tenantTransaction } from '@/lib/db-context';
import { can } from '@/lib/rbac';
import { serializeCompany } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

import { parseSiteInput } from './geo';
import {
  asActor,
  isUuid,
  mapsOf,
  nowOf,
  optText,
  publishMeetingUpdated,
  type FieldDeps,
  type Tx,
} from './internal';
import { geocodeCached } from './maps/cached';
import type { MapsProvider } from './maps';
import { assertCanActFor, assertCanWrite, lockManagedMeeting, lockOwnedMeeting } from './scope';
import { assertTransition } from './state-machine';
import { FieldError, type FieldActor, type LatLng } from './types';

export type CreateMeetingInput = {
  title: string;
  type: 'physical' | 'virtual';
  startAt: Date;
  endAt: Date;
  ownerId?: string;
  dealId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  address?: string | null;
  virtualUrl?: string | null;
  notes?: string | null;
};

type Site = { address: string | null; lat: number | null; lng: number | null; geocodeStatus: GeocodeStatus };

function requireTitle(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) throw new FieldError('validation', 'Title is required');
  if (t.length > 300) throw new FieldError('validation', 'Title is too long (max 300)');
  return t;
}

function requireType(v: unknown): 'physical' | 'virtual' {
  if (v === 'physical' || v === 'virtual') return v;
  throw new FieldError('validation', 'Type must be physical or virtual');
}

function requireTimes(startAt: unknown, endAt: unknown): { startAt: Date; endAt: Date } {
  const ok = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
  if (!ok(startAt) || !ok(endAt)) throw new FieldError('validation', 'Start and end times are required');
  if (endAt.getTime() <= startAt.getTime()) throw new FieldError('validation', 'End must be after start');
  return { startAt, endAt };
}

/** Each given link must exist in the tenant (RLS hides other tenants and deleted rows). */
export async function checkLinks(
  tx: Tx,
  tenantId: string,
  links: { dealId?: string | null; companyId?: string | null; contactId?: string | null },
): Promise<{ company: Company | null }> {
  const bad = (what: string) => new FieldError('validation', `${what} not found`);
  if (links.dealId != null) {
    if (!isUuid(links.dealId)) throw bad('Deal');
    const [d] = await tx.select({ id: deals.id }).from(deals).where(and(eq(deals.tenantId, tenantId), eq(deals.id, links.dealId))).limit(1);
    if (!d) throw bad('Deal');
  }
  if (links.contactId != null) {
    if (!isUuid(links.contactId)) throw bad('Contact');
    const [c] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, links.contactId)))
      .limit(1);
    if (!c) throw bad('Contact');
  }
  let company: Company | null = null;
  if (links.companyId != null) {
    if (!isUuid(links.companyId)) throw bad('Company');
    const [c] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, links.companyId)))
      .limit(1);
    if (!c) throw bad('Company');
    company = c;
  }
  return { company };
}

/** Geocode an address; a provider failure never blocks saving (status 'failed'). */
async function geocodeSite(
  tx: Tx,
  tenantId: string,
  address: string,
  maps: MapsProvider,
  now: () => Date,
): Promise<Site> {
  try {
    const r = await geocodeCached(tx, tenantId, address, maps, { now });
    if (r.status === 'ok' && r.point) return { address, lat: r.point.lat, lng: r.point.lng, geocodeStatus: 'ok' };
    return { address, lat: null, lng: null, geocodeStatus: r.status === 'pending' ? 'pending' : 'failed' };
  } catch {
    return { address, lat: null, lng: null, geocodeStatus: 'failed' };
  }
}

/**
 * Site for an address on a physical meeting: the company's coordinates (manual
 * pins included) when the address is the company's own; otherwise geocoded.
 */
async function siteFor(
  tx: Tx,
  tenantId: string,
  address: string | null,
  company: Company | null,
  maps: MapsProvider,
  now: () => Date,
): Promise<Site> {
  const addr = address ?? company?.address ?? null;
  if (company && company.lat !== null && company.lng !== null && (addr === null || addr === company.address)) {
    return { address: addr, lat: company.lat, lng: company.lng, geocodeStatus: company.geocodeStatus ?? 'ok' };
  }
  if (!addr) return { address: null, lat: null, lng: null, geocodeStatus: 'pending' };
  return geocodeSite(tx, tenantId, addr, maps, now);
}

export function createMeeting(actor: FieldActor, input: CreateMeetingInput, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    const title = requireTitle(input.title);
    const type = requireType(input.type);
    const { startAt, endAt } = requireTimes(input.startAt, input.endAt);
    const ownerId = input.ownerId ?? actor.userId;
    await assertCanActFor(actor, ownerId);
    const address = optText(input.address, 'Address', 500);
    const virtualUrl = optText(input.virtualUrl, 'Meeting link', 2000);
    const notes = optText(input.notes, 'Notes');
    const maps = mapsOf(deps);
    const now = () => nowOf(deps);

    return tenantTransaction(async (tx) => {
      const { company } = await checkLinks(tx, actor.tenantId, input);
      const site: Site =
        type === 'physical'
          ? await siteFor(tx, actor.tenantId, address, company, maps, now)
          : { address, lat: null, lng: null, geocodeStatus: 'pending' };
      const [row] = await tx
        .insert(meetings)
        .values({
          tenantId: actor.tenantId,
          ownerId,
          title,
          type,
          startAt,
          endAt,
          dealId: input.dealId ?? null,
          companyId: input.companyId ?? null,
          contactId: input.contactId ?? null,
          ...site,
          virtualUrl,
          notes,
          source: 'manual',
          status: 'planned',
          createdBy: actor.userId,
        })
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

export function updateMeeting(
  actor: FieldActor,
  id: string,
  patch: Partial<CreateMeetingInput>,
  deps?: FieldDeps,
): Promise<Meeting> {
  return asActor(actor, () =>
    tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, id);
      if (cur.status === 'cancelled') {
        throw new FieldError('invalid_transition', 'A cancelled meeting cannot be edited', { from: cur.status });
      }
      const set: Partial<typeof meetings.$inferInsert> = {};
      if (patch.ownerId !== undefined && patch.ownerId !== cur.ownerId) {
        await assertCanActFor(actor, patch.ownerId);
        set.ownerId = patch.ownerId;
      }
      if (patch.title !== undefined) set.title = requireTitle(patch.title);
      if (patch.type !== undefined) set.type = requireType(patch.type);
      if (patch.startAt !== undefined || patch.endAt !== undefined) {
        Object.assign(set, requireTimes(patch.startAt ?? cur.startAt, patch.endAt ?? cur.endAt));
      }
      if (patch.virtualUrl !== undefined) set.virtualUrl = optText(patch.virtualUrl, 'Meeting link', 2000);
      if (patch.notes !== undefined) set.notes = optText(patch.notes, 'Notes');
      for (const k of ['dealId', 'companyId', 'contactId'] as const) {
        if (patch[k] !== undefined) set[k] = patch[k] ?? null;
      }
      // Only links being changed are validated; an untouched link never blocks an edit.
      const checked = await checkLinks(tx, actor.tenantId, {
        dealId: set.dealId,
        contactId: set.contactId,
        companyId: set.companyId,
      });

      const address = patch.address !== undefined ? optText(patch.address, 'Address', 500) : undefined;
      const addressChanged = address !== undefined && address !== cur.address;
      const companyChanged = set.companyId !== undefined && set.companyId !== cur.companyId;
      const type = set.type ?? cur.type;
      if (cur.geocodeStatus === 'manual' || type === 'virtual') {
        // A manual pin survives address edits; only the label changes.
        if (addressChanged) set.address = address;
      } else if (addressChanged || (companyChanged && address === undefined && checked.company)) {
        const companyId = set.companyId !== undefined ? set.companyId : cur.companyId;
        const company =
          checked.company ??
          (companyId
            ? ((
                await tx
                  .select()
                  .from(companies)
                  .where(and(eq(companies.tenantId, actor.tenantId), eq(companies.id, companyId)))
                  .limit(1)
              )[0] ?? null)
            : null);
        const maps = mapsOf(deps);
        Object.assign(set, await siteFor(tx, actor.tenantId, addressChanged ? address : null, company, maps, () => nowOf(deps)));
      }

      if (Object.keys(set).length === 0) return cur;
      const [row] = await tx
        .update(meetings)
        .set({ ...set, updatedAt: nowOf(deps) })
        .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, cur.id)))
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    }),
  );
}

export function cancelMeeting(actor: FieldActor, id: string, reason?: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, () =>
    tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, id);
      assertTransition(cur.status, 'cancelled', cur.type);
      const now = nowOf(deps);
      const [row] = await tx
        .update(meetings)
        .set({ status: 'cancelled', cancelledAt: now, cancelReason: optText(reason, 'Reason', 1000), updatedAt: now })
        .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, cur.id)))
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    }),
  );
}

const ALREADY_ON_THE_WAY = new Set<Meeting['status']>(['en_route', 'arrived', 'checked_in']);

/** Navigate tapped. Repeated taps (or a later state) are a no-op. */
export function markEnRoute(actor: FieldActor, id: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, () =>
    tenantTransaction(async (tx) => {
      const cur = await lockOwnedMeeting(tx, actor, id);
      if (ALREADY_ON_THE_WAY.has(cur.status)) return cur;
      assertTransition(cur.status, 'en_route', cur.type);
      const [row] = await tx
        .update(meetings)
        .set({ status: 'en_route', updatedAt: nowOf(deps) })
        .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, cur.id)))
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    }),
  );
}

function assertCanPin(actor: FieldActor): void {
  if (!can(actor.role, 'pinFieldSites')) throw new FieldError('forbidden', 'Only managers and admins can pin a site');
}

/** A Google Maps link (short links resolved server-side) or "lat, lng" → a point. */
async function resolvePin(input: string, maps: MapsProvider): Promise<LatLng> {
  const bad = () => new FieldError('validation', 'Paste a Google Maps link or "lat, lng"');
  if (typeof input !== 'string' || input.length > 2000) throw bad();
  const parsed = parseSiteInput(input);
  if (!parsed) throw bad();
  if (parsed.kind === 'point') return parsed.point;
  const resolved = await maps.resolveShortUrl(parsed.url);
  const again = resolved ? parseSiteInput(resolved) : null;
  if (again?.kind !== 'point') throw bad();
  return again.point;
}

export function pinMeetingSite(actor: FieldActor, id: string, input: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanPin(actor);
    const point = await resolvePin(input, mapsOf(deps));
    return tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, id);
      const [row] = await tx
        .update(meetings)
        .set({ lat: point.lat, lng: point.lng, geocodeStatus: 'manual', updatedAt: nowOf(deps) })
        .where(and(eq(meetings.tenantId, actor.tenantId), eq(meetings.id, cur.id)))
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

/** Pin a company site; `radiusM` undefined keeps the override, null clears it. */
export function pinCompanySite(
  actor: FieldActor,
  companyId: string,
  input: string,
  radiusM?: number | null,
  deps?: FieldDeps,
): Promise<Company> {
  return asActor(actor, async () => {
    assertCanPin(actor);
    assertCanWrite(actor);
    if (radiusM != null && (!Number.isInteger(radiusM) || radiusM < 50 || radiusM > 5000)) {
      throw new FieldError('validation', 'Check-in radius must be a whole number from 50 to 5000 m');
    }
    if (!isUuid(companyId)) throw new FieldError('not_found', 'Company not found');
    const point = await resolvePin(input, mapsOf(deps));
    return tenantTransaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({
          lat: point.lat,
          lng: point.lng,
          geocodeStatus: 'manual',
          ...(radiusM !== undefined ? { checkinRadiusM: radiusM } : {}),
          updatedAt: nowOf(deps),
          updatedBy: actor.userId,
        })
        .where(and(eq(companies.tenantId, actor.tenantId), eq(companies.id, companyId)))
        .returning();
      if (!row) throw new FieldError('not_found', 'Company not found');
      await publishRealtimeEvent(tx, { type: 'company.updated', tenantId: actor.tenantId, company: serializeCompany(row) });
      return row;
    });
  });
}
