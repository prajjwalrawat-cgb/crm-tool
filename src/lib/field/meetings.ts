import 'server-only';

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { companies, contacts, deals, meetings, type Company, type Meeting, type NewMeeting } from '@/db/schema';
import type { MeetingStatus } from '@/db/schema/enums';
import { tenantTransaction } from '@/lib/db-context';
import { can } from '@/lib/rbac';
import { serializeCompany } from '@/lib/realtime/payloads';
import { publishRealtimeEvent } from '@/lib/realtime/publisher';

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
import {
  assertCanActFor,
  assertCanActForTx,
  assertCanWrite,
  canSeeOwner,
  fieldUserScope,
  lockManagedMeeting,
  lockOwnedMeeting,
  readMeeting,
} from './scope';
import {
  companyGeocodeLine,
  fetchPre,
  geocodeTarget,
  isCompanyAddress,
  lookupPre,
  resolvePin,
  siteFor,
  type PreGeocode,
  type Site,
} from './site';
import { visibleCompanies, visibleContacts, visibleDeals } from './pickers';
import { assertTransition } from './state-machine';
import { FieldError, type FieldActor } from './types';

/**
 * Meeting writes. Pool rule: scope checks and geocoding happen BEFORE the write
 * transaction; inside it only the caller's `tx` is used (no second connection
 * while a row lock is held, no network call under the lock).
 */

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

/**
 * Each given link must be a record the actor can see: same rule as the meeting
 * form pickers (visibleDeals / visibleCompanies / visibleContacts, i.e. the CRM's
 * ownerOrUnassignedRestriction). A missing and an invisible id get the same
 * answer, so the check never reveals that another rep's record exists.
 */
export async function checkLinks(
  tx: Tx,
  actor: FieldActor,
  links: { dealId?: string | null; companyId?: string | null; contactId?: string | null },
): Promise<{ company: Company | null }> {
  const bad = (what: string) => new FieldError('validation', `That ${what} is not available.`);
  if (links.dealId != null) {
    if (!isUuid(links.dealId)) throw bad('deal');
    const [d] = await tx
      .select({ id: deals.id })
      .from(deals)
      .where(and(...visibleDeals(actor), eq(deals.id, links.dealId)))
      .limit(1);
    if (!d) throw bad('deal');
  }
  if (links.contactId != null) {
    if (!isUuid(links.contactId)) throw bad('contact');
    const [c] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(...visibleContacts(actor), eq(contacts.id, links.contactId)))
      .limit(1);
    if (!c) throw bad('contact');
  }
  let company: Company | null = null;
  if (links.companyId != null) {
    if (!isUuid(links.companyId)) throw bad('company');
    const [c] = await tx
      .select()
      .from(companies)
      .where(and(...visibleCompanies(actor), eq(companies.id, links.companyId)))
      .limit(1);
    if (!c) throw bad('company');
    company = c;
  }
  return { company };
}

async function loadCompany(tx: Tx, tenantId: string, id: string | null): Promise<Company | null> {
  if (!id || !isUuid(id)) return null;
  const [c] = await tx
    .select()
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, id)))
    .limit(1);
  return c ?? null;
}

/**
 * A typed address the actor cannot pin is "rep-entered": check-ins are verified
 * against it, and the manager board marks it so someone can confirm or pin it.
 */
const repEntered = (actor: FieldActor, site: Pick<Site, 'siteSource'>): boolean =>
  site.siteSource === 'address' && !can(actor.role, 'pinFieldSites');

/** Site columns a re-site writes, including the source marker. */
const siteColumns = (actor: FieldActor, site: Site): Partial<NewMeeting> => ({
  ...site,
  siteRepEntered: repEntered(actor, site),
});

const setMeeting = (tx: Tx, m: Meeting, values: Partial<NewMeeting>) =>
  tx
    .update(meetings)
    .set(values)
    .where(and(eq(meetings.tenantId, m.tenantId), eq(meetings.id, m.id)))
    .returning();

export function createMeeting(actor: FieldActor, input: CreateMeetingInput, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanWrite(actor);
    const title = requireTitle(input.title);
    const type = requireType(input.type);
    const { startAt, endAt } = requireTimes(input.startAt, input.endAt);
    const ownerId = input.ownerId ?? actor.userId;
    const address = optText(input.address, 'Address', 500);
    const virtualUrl = optText(input.virtualUrl, 'Meeting link', 2000);
    const notes = optText(input.notes, 'Notes');
    const maps = mapsOf(deps);
    const now = () => nowOf(deps);
    await assertCanActFor(actor, ownerId);

    // Plan + geocode before the write transaction.
    let pre: PreGeocode = null;
    if (type === 'physical') {
      const plan = await tenantTransaction(async (tx) => {
        const { company } = await checkLinks(tx, actor, input);
        const target = geocodeTarget(address, company);
        return { target, cached: await lookupPre(tx, actor.tenantId, target) };
      });
      pre = await fetchPre(plan.target, plan.cached, maps);
    }

    return tenantTransaction(async (tx) => {
      const { company } = await checkLinks(tx, actor, input);
      const site: Site =
        type === 'physical'
          ? await siteFor(tx, actor.tenantId, address, company, pre, maps.name, now)
          : { address, lat: null, lng: null, geocodeStatus: 'pending', siteSource: null };
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
          ...siteColumns(actor, site),
          virtualUrl,
          notes,
          source: 'manual',
          status: 'planned',
          // A meeting without a deal waits in the "needs a deal" queue; linking one via Edit clears it.
          needsLinking: !input.dealId,
          createdBy: actor.userId,
        })
        .returning();
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

/** Type, owner, times, link and site may change only before the visit starts. */
const PRE_VISIT = new Set<MeetingStatus>(['planned', 'en_route']);

type UpdatePlan = {
  set: Partial<NewMeeting>;
  ownerChange: string | null;
  /**
   * Re-site from this address and company. address null = the company's;
   * undefined = keep the meeting's own address, or follow the company when the
   * current address was inherited from the old one (see resiteInput).
   */
  resite: { address: string | null | undefined; companyId: string | null } | null;
};

/**
 * Pure: which columns a patch changes, gated by status. Only real changes count,
 * so a form that resends unchanged fields works on any status.
 *   planned / en_route → anything
 *   arrived / checked_in / checked_out → title, notes, deal/company/contact links
 *   mom_logged → notes only;  cancelled → nothing
 */
function buildUpdate(cur: Meeting, patch: Partial<CreateMeetingInput>): UpdatePlan {
  if (cur.status === 'cancelled') {
    throw new FieldError('invalid_transition', 'A cancelled meeting cannot be edited', { from: cur.status });
  }
  const set: Partial<NewMeeting> = {};
  const structural: string[] = [];
  const visitSafe: string[] = [];
  let ownerChange: string | null = null;

  if (patch.type !== undefined) {
    const t = requireType(patch.type);
    if (t !== cur.type) {
      set.type = t;
      structural.push('type');
    }
  }
  if (patch.ownerId !== undefined && patch.ownerId !== cur.ownerId) {
    ownerChange = patch.ownerId;
    set.ownerId = patch.ownerId;
    structural.push('owner');
  }
  if (patch.startAt !== undefined || patch.endAt !== undefined) {
    const t = requireTimes(patch.startAt ?? cur.startAt, patch.endAt ?? cur.endAt);
    if (t.startAt.getTime() !== cur.startAt.getTime() || t.endAt.getTime() !== cur.endAt.getTime()) {
      Object.assign(set, t);
      structural.push('time');
    }
  }
  if (patch.virtualUrl !== undefined) {
    const v = optText(patch.virtualUrl, 'Meeting link', 2000);
    if (v !== cur.virtualUrl) {
      set.virtualUrl = v;
      structural.push('meeting link');
    }
  }
  let address: string | null | undefined;
  if (patch.address !== undefined) {
    const a = optText(patch.address, 'Address', 500);
    if (a !== cur.address) {
      address = a;
      structural.push('address');
    }
  }
  if (patch.title !== undefined) {
    const t = requireTitle(patch.title);
    if (t !== cur.title) {
      set.title = t;
      visitSafe.push('title');
    }
  }
  for (const k of ['dealId', 'companyId', 'contactId'] as const) {
    if (patch[k] !== undefined && (patch[k] ?? null) !== cur[k]) {
      set[k] = patch[k] ?? null;
      visitSafe.push(k);
    }
  }
  if (patch.notes !== undefined) {
    const n = optText(patch.notes, 'Notes');
    if (n !== cur.notes) set.notes = n;
  }
  if (set.dealId !== undefined) set.needsLinking = set.dealId === null;
  if (set.type === 'virtual') {
    set.siteSource = null;
    set.siteRepEntered = false;
  }

  if (structural.length > 0 && !PRE_VISIT.has(cur.status)) {
    throw new FieldError('invalid_transition', `Cannot change ${structural.join(', ')} once the visit has started`, {
      from: cur.status,
      fields: structural,
    });
  }
  if (visitSafe.length > 0 && cur.status === 'mom_logged') {
    throw new FieldError('invalid_transition', 'Only notes can change after the MOM is logged', {
      from: cur.status,
      fields: visitSafe,
    });
  }

  const type = set.type ?? cur.type;
  // A meeting's own pin (or walk-in position) is never re-sited by an edit. A point copied from a
  // pinned company is not the meeting's pin: editing the address re-sites it.
  const ownPoint =
    cur.siteSource === 'pin' || cur.siteSource === 'walk_in' || (cur.siteSource === null && cur.geocodeStatus === 'manual');
  const sitable = PRE_VISIT.has(cur.status) && !ownPoint && type === 'physical';
  let resite: UpdatePlan['resite'] = null;
  if (address !== undefined) {
    // A manual pin (or a virtual meeting) keeps its coordinates; only the label changes.
    if (sitable) resite = { address, companyId: set.companyId !== undefined ? set.companyId : cur.companyId };
    else set.address = address;
  } else if (sitable && (set.companyId !== undefined || set.type === 'physical')) {
    // Company changed or cleared, or the meeting became physical: re-site from the
    // (new) company or the meeting's own address. Never keep the old company's point.
    resite = { address: undefined, companyId: set.companyId !== undefined ? set.companyId : cur.companyId };
  }
  return { set, ownerChange, resite };
}

/**
 * The address and company to re-site from. With no explicit address, a meeting whose
 * address was inherited from its old company (blank, or that company's line) follows
 * the new company (none when the link was cleared); its own address is kept and geocoded.
 */
async function resiteInput(
  tx: Tx,
  tenantId: string,
  cur: Meeting,
  resite: NonNullable<UpdatePlan['resite']>,
): Promise<{ address: string | null; company: Company | null }> {
  const company = await loadCompany(tx, tenantId, resite.companyId);
  if (resite.address !== undefined) return { address: resite.address, company };
  const old = cur.companyId === resite.companyId ? company : await loadCompany(tx, tenantId, cur.companyId);
  const inherited = !cur.address || isCompanyAddress(cur.address, old);
  return { address: inherited ? null : cur.address, company };
}

export function updateMeeting(
  actor: FieldActor,
  id: string,
  patch: Partial<CreateMeetingInput>,
  deps?: FieldDeps,
): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanWrite(actor);
    const scope = await fieldUserScope(actor);
    const maps = mapsOf(deps);
    const now = () => nowOf(deps);

    // Planning read (no lock) so the geocoder runs outside the write transaction.
    const plan = await tenantTransaction(async (tx) => {
      const cur = await readMeeting(tx, actor, id);
      if (!canSeeOwner(actor, scope, cur.ownerId)) throw new FieldError('not_found', 'Meeting not found');
      const { resite } = buildUpdate(cur, patch);
      if (!resite) return { target: null, cached: null };
      const input = await resiteInput(tx, actor.tenantId, cur, resite);
      const target = geocodeTarget(input.address, input.company);
      return { target, cached: await lookupPre(tx, actor.tenantId, target) };
    });
    const pre = await fetchPre(plan.target, plan.cached, maps);

    return tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, scope, id);
      const { set, ownerChange, resite } = buildUpdate(cur, patch);
      if (ownerChange !== null) await assertCanActForTx(tx, actor, scope, ownerChange);
      // Only links being changed are validated; an untouched link never blocks an edit.
      await checkLinks(tx, actor, { dealId: set.dealId, contactId: set.contactId, companyId: set.companyId });
      if (resite) {
        const input = await resiteInput(tx, actor.tenantId, cur, resite);
        Object.assign(set, siteColumns(actor, await siteFor(tx, actor.tenantId, input.address, input.company, pre, maps.name, now)));
      }
      if (Object.keys(set).length === 0) return cur;
      const [row] = await setMeeting(tx, cur, { ...set, updatedAt: now() });
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

export function cancelMeeting(actor: FieldActor, id: string, reason?: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanWrite(actor);
    const scope = await fieldUserScope(actor);
    const cancelReason = optText(reason, 'Reason', 1000);
    return tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, scope, id);
      assertTransition(cur.status, 'cancelled', cur.type);
      const now = nowOf(deps);
      const [row] = await setMeeting(tx, cur, { status: 'cancelled', cancelledAt: now, cancelReason, updatedAt: now });
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

const ALREADY_ON_THE_WAY = new Set<MeetingStatus>(['en_route', 'arrived', 'checked_in']);

/** Navigate tapped. Repeated taps (or a later state) are a no-op. */
export function markEnRoute(actor: FieldActor, id: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanWrite(actor);
    const scope = await fieldUserScope(actor);
    return tenantTransaction(async (tx) => {
      const cur = await lockOwnedMeeting(tx, actor, scope, id);
      if (ALREADY_ON_THE_WAY.has(cur.status)) return cur;
      assertTransition(cur.status, 'en_route', cur.type);
      const [row] = await setMeeting(tx, cur, { status: 'en_route', updatedAt: nowOf(deps) });
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

function assertCanPin(actor: FieldActor): void {
  if (!can(actor.role, 'pinFieldSites')) throw new FieldError('forbidden', 'Only managers and admins can pin a site');
}

/** A site can be pinned until the rep checks in. */
const PINNABLE = new Set<MeetingStatus>(['planned', 'en_route', 'arrived']);

export function pinMeetingSite(actor: FieldActor, id: string, input: string, deps?: FieldDeps): Promise<Meeting> {
  return asActor(actor, async () => {
    assertCanPin(actor);
    const scope = await fieldUserScope(actor);
    const point = await resolvePin(input, mapsOf(deps));
    return tenantTransaction(async (tx) => {
      const cur = await lockManagedMeeting(tx, actor, scope, id);
      if (cur.type === 'virtual') throw new FieldError('validation', 'A virtual meeting has no site to pin');
      if (!PINNABLE.has(cur.status)) {
        throw new FieldError('invalid_transition', `Cannot move the site of a ${cur.status} meeting`, { from: cur.status });
      }
      const [row] = await setMeeting(tx, cur, {
        lat: point.lat,
        lng: point.lng,
        geocodeStatus: 'manual',
        // A manager's pin: the rep-entered marker is cleared.
        siteSource: 'pin',
        siteRepEntered: false,
        updatedAt: nowOf(deps),
      });
      await publishMeetingUpdated(tx, row!);
      return row!;
    });
  });
}

/**
 * Meetings that use their company's site (site_source 'company', or not classified).
 * A meeting's own pin, its own typed address and a walk-in position never follow the company.
 */
const inheritsCompanySite = or(isNull(meetings.siteSource), eq(meetings.siteSource, 'company'))!;

/**
 * A company's address re-geocode succeeded (non-manual): give its new point to its
 * not-started physical meetings that still have no site, no manual pin, and whose
 * address is the company's (blank, or one of `companyAddresses`, old or new). A
 * meeting with its own, different address keeps waiting for its own geocode.
 * Runs inside the caller's write transaction; no network.
 */
export async function propagateCompanyPoint(
  tx: Tx,
  tenantId: string,
  company: Company & { lat: number; lng: number },
  companyAddresses: Array<string | null>,
  now: Date,
): Promise<number> {
  const known = [...new Set(companyAddresses.filter((a): a is string => !!a))];
  const inherited = known.length
    ? sql`(${meetings.address} IS NULL OR ${meetings.address} = '' OR ${inArray(meetings.address, known)})`
    : sql`(${meetings.address} IS NULL OR ${meetings.address} = '')`;
  const moved = await tx
    .update(meetings)
    .set({
      lat: company.lat,
      lng: company.lng,
      geocodeStatus: 'ok',
      address: companyGeocodeLine(company),
      siteSource: 'company',
      siteRepEntered: false,
      updatedAt: now,
    })
    .where(
      and(
        eq(meetings.tenantId, tenantId),
        eq(meetings.companyId, company.id),
        eq(meetings.type, 'physical'),
        inArray(meetings.status, [...PINNABLE]),
        isNull(meetings.lat),
        inheritsCompanySite,
        inherited,
      ),
    )
    .returning({ id: meetings.id, tenantId: meetings.tenantId, ownerId: meetings.ownerId });
  for (const m of moved) await publishMeetingUpdated(tx, m);
  return moved.length;
}

/**
 * Pin a company site; `radiusM` undefined keeps the override, null clears it.
 * The pin also moves that company's physical meetings that have not started
 * (planned / en_route / arrived) and use the company's site (inheritsCompanySite):
 * never a meeting's own pin, its own typed address, or a walk-in.
 */
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
      const now = nowOf(deps);
      const [row] = await tx
        .update(companies)
        .set({
          lat: point.lat,
          lng: point.lng,
          geocodeStatus: 'manual',
          ...(radiusM !== undefined ? { checkinRadiusM: radiusM } : {}),
          updatedAt: now,
          updatedBy: actor.userId,
        })
        .where(and(eq(companies.tenantId, actor.tenantId), eq(companies.id, companyId)))
        .returning();
      if (!row) throw new FieldError('not_found', 'Company not found');
      await publishRealtimeEvent(tx, { type: 'company.updated', tenantId: actor.tenantId, company: serializeCompany(row) });

      const moved = await tx
        .update(meetings)
        .set({
          lat: point.lat,
          lng: point.lng,
          geocodeStatus: 'manual',
          address: sql`COALESCE(NULLIF(${meetings.address}, ''), ${companyGeocodeLine(row)}::text)`,
          siteSource: 'company',
          siteRepEntered: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(meetings.tenantId, actor.tenantId),
            eq(meetings.companyId, row.id),
            eq(meetings.type, 'physical'),
            inArray(meetings.status, [...PINNABLE]),
            inheritsCompanySite,
          ),
        )
        .returning({ id: meetings.id, tenantId: meetings.tenantId, ownerId: meetings.ownerId });
      for (const m of moved) await publishMeetingUpdated(tx, m);
      return row;
    });
  });
}
