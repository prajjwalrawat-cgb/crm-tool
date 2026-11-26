import 'server-only';

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { companies, tenantFieldSettings } from '@/db/schema';
import type { MembershipRole } from '@/db/schema/enums';
import { can } from '@/lib/rbac';
import type { DbExecutor } from '@/lib/db-context';
import { FieldError } from './types';

export type FieldSettings = {
  locationProvider: 'askmira' | 'native' | 'none';
  checkinRadiusM: number;
  graceMin: number;
  momDueHours: number;
  trackingStart: string;
  trackingEnd: string;
  trackingIntervalSec: number;
  /** Check-in opens this many minutes before the meeting starts. */
  checkinOpensBeforeMin: number;
  /** Check-in closes this many minutes after the meeting ends. */
  checkinClosesAfterMin: number;
};

export const FIELD_SETTINGS_DEFAULTS: FieldSettings = {
  locationProvider: 'none',
  checkinRadiusM: 300,
  graceMin: 15,
  momDueHours: 2,
  trackingStart: '09:00',
  trackingEnd: '19:00',
  trackingIntervalSec: 120,
  checkinOpensBeforeMin: 120,
  checkinClosesAfterMin: 240,
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const patchSchema = z
  .object({
    checkinRadiusM: z.number().int().min(50).max(5000),
    graceMin: z.number().int().min(0).max(120),
    momDueHours: z.number().int().min(1).max(72),
    trackingStart: hhmm,
    trackingEnd: hhmm,
    checkinOpensBeforeMin: z.number().int().min(0).max(1440),
    checkinClosesAfterMin: z.number().int().min(0).max(1440),
  })
  .partial()
  .strict();

export type FieldSettingsPatch = z.input<typeof patchSchema>;

const hm = (t: string) => t.slice(0, 5);

export async function getFieldSettings(tx: DbExecutor, tenantId: string): Promise<FieldSettings> {
  const [r] = await tx.select().from(tenantFieldSettings).where(eq(tenantFieldSettings.tenantId, tenantId)).limit(1);
  if (!r) return { ...FIELD_SETTINGS_DEFAULTS };
  return {
    locationProvider: r.locationProvider,
    checkinRadiusM: r.checkinRadiusM,
    graceMin: r.noCheckinGraceMin,
    momDueHours: r.momDueHours,
    trackingStart: hm(r.trackingStart),
    trackingEnd: hm(r.trackingEnd),
    trackingIntervalSec: r.trackingIntervalSec,
    checkinOpensBeforeMin: r.checkinOpensBeforeMin,
    checkinClosesAfterMin: r.checkinClosesAfterMin,
  };
}

/** The meeting's company radius override, else the tenant radius. */
export async function effectiveRadius(
  tx: DbExecutor,
  tenantId: string,
  companyId: string | null,
  tenantRadiusM?: number,
): Promise<number> {
  if (companyId) {
    const [c] = await tx
      .select({ r: companies.checkinRadiusM })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .limit(1);
    if (c?.r != null) return c.r;
  }
  return tenantRadiusM ?? (await getFieldSettings(tx, tenantId)).checkinRadiusM;
}

export async function saveFieldSettings(
  tx: DbExecutor,
  tenantId: string,
  patch: FieldSettingsPatch,
): Promise<FieldSettings> {
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new FieldError('validation', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const current = await getFieldSettings(tx, tenantId);
  const next = { ...current, ...parsed.data };
  if (!(next.trackingStart < next.trackingEnd)) {
    throw new FieldError('validation', 'trackingStart must be before trackingEnd');
  }
  const values = {
    checkinRadiusM: next.checkinRadiusM,
    noCheckinGraceMin: next.graceMin,
    momDueHours: next.momDueHours,
    trackingStart: next.trackingStart,
    trackingEnd: next.trackingEnd,
    checkinOpensBeforeMin: next.checkinOpensBeforeMin,
    checkinClosesAfterMin: next.checkinClosesAfterMin,
  };
  await tx
    .insert(tenantFieldSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: tenantFieldSettings.tenantId, set: { ...values, updatedAt: new Date() } });
  return next;
}

/** Fields a manager may change (`manageFieldCheckinWindow`); every other field needs `manageFieldSettings`. */
export const CHECKIN_WINDOW_FIELDS = ['checkinOpensBeforeMin', 'checkinClosesAfterMin'] as const;

/**
 * Saves a patch after per-field permission checks for `role`: a patch that
 * touches a field the role cannot edit is rejected whole (forbidden), nothing saved.
 */
export async function saveFieldSettingsAs(
  tx: DbExecutor,
  tenantId: string,
  role: MembershipRole | null | undefined,
  patch: FieldSettingsPatch,
): Promise<FieldSettings> {
  const keys = Object.keys(patch).filter((k) => patch[k as keyof FieldSettingsPatch] !== undefined);
  const windowKeys = new Set<string>(CHECKIN_WINDOW_FIELDS);
  const other = keys.filter((k) => !windowKeys.has(k));
  if (other.length > 0 && !can(role, 'manageFieldSettings')) {
    throw new FieldError('forbidden', 'Only owners and admins can change the check-in radius, grace, notes due and tracking hours.');
  }
  if (keys.some((k) => windowKeys.has(k)) && !can(role, 'manageFieldCheckinWindow')) {
    throw new FieldError('forbidden', 'Only owners, admins and managers can change the check-in window.');
  }
  return saveFieldSettings(tx, tenantId, patch);
}

/** True when `now`, read in `tz`, falls in [trackingStart, trackingEnd). */
export function isWithinTrackingHours(s: FieldSettings, now: Date, tz: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const cur = `${h === '24' ? '00' : h}:${m}`;
  return cur >= hm(s.trackingStart) && cur < hm(s.trackingEnd);
}
