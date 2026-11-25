import 'server-only';

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { tenantFieldSettings } from '@/db/schema';
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
};

export const FIELD_SETTINGS_DEFAULTS: FieldSettings = {
  locationProvider: 'none',
  checkinRadiusM: 300,
  graceMin: 15,
  momDueHours: 2,
  trackingStart: '09:00',
  trackingEnd: '19:00',
  trackingIntervalSec: 120,
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const patchSchema = z
  .object({
    checkinRadiusM: z.number().int().min(50).max(5000),
    graceMin: z.number().int().min(0).max(120),
    momDueHours: z.number().int().min(1).max(72),
    trackingStart: hhmm,
    trackingEnd: hhmm,
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
  };
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
  };
  await tx
    .insert(tenantFieldSettings)
    .values({ tenantId, ...values })
    .onConflictDoUpdate({ target: tenantFieldSettings.tenantId, set: { ...values, updatedAt: new Date() } });
  return next;
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
