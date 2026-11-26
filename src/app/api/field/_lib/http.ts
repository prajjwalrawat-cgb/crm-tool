import { z, ZodError } from 'zod';

import { FieldError, type FieldErrorCode } from '@/lib/field/types';

/**
 * Pure HTTP helpers for the field routes: error mapping and body parsing.
 * No auth / DB imports so they can be self-tested without a session.
 */

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export const jsonResponse = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: NO_STORE });

export const errorBody = (message: string, status: number): Response => jsonResponse({ error: message }, status);

const STATUS: Record<FieldErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  validation: 400,
  invalid_transition: 409,
  outside_radius: 422,
  outside_window: 422,
};

/**
 * Unexpected-error sink. Wired to `captureError` by actor.ts; kept injectable so
 * this module has no observability / DB imports (pure self-test).
 */
let reportUnexpected: (err: unknown) => void = () => {};
export function setFieldErrorReporter(fn: (err: unknown) => void): void {
  reportUnexpected = fn;
}

export function fieldErrorResponse(err: unknown): Response {
  if (err instanceof FieldError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.code === 'outside_radius') {
      body.distanceM = err.details?.distanceM;
      body.radiusM = err.details?.radiusM;
    }
    if (err.code === 'outside_window') {
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      body.opensAt = iso(err.details?.opensAt);
      body.closesAt = iso(err.details?.closesAt);
    }
    return jsonResponse(body, STATUS[err.code]);
  }
  if (err instanceof ZodError) {
    return jsonResponse(
      {
        error: 'Some fields are invalid.',
        code: 'validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  reportUnexpected(err);
  return jsonResponse({ error: 'Something went wrong.' }, 500);
}

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const uuid = z.uuid();
const userId = z.string().min(1).max(200);
const position = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(1_000_000),
});
const checkInSchema = position.extend({ overrideReason: z.string().max(500).optional() });

const meetingFields = {
  title: z.string().max(300),
  type: z.enum(['physical', 'virtual']),
  startAt: isoDate,
  endAt: isoDate,
  ownerId: userId,
  dealId: uuid.nullable(),
  companyId: uuid.nullable(),
  contactId: uuid.nullable(),
  address: z.string().max(1000).nullable(),
  virtualUrl: z.string().max(2000).nullable(),
  notes: z.string().max(20_000).nullable(),
};

const createSchema = z.object({
  title: meetingFields.title,
  type: meetingFields.type,
  startAt: meetingFields.startAt,
  endAt: meetingFields.endAt,
  ownerId: meetingFields.ownerId.optional(),
  dealId: meetingFields.dealId.optional(),
  companyId: meetingFields.companyId.optional(),
  contactId: meetingFields.contactId.optional(),
  address: meetingFields.address.optional(),
  virtualUrl: meetingFields.virtualUrl.optional(),
  notes: meetingFields.notes.optional(),
});
const updateSchema = z.object(meetingFields).partial();
const cancelSchema = z.object({ reason: z.string().max(500).optional() });
const siteSchema = z.object({ input: z.string().min(1).max(2000) });
const walkInSchema = position.extend({
  title: z.string().max(300).optional(),
  dealId: uuid.nullable().optional(),
  companyId: uuid.nullable().optional(),
  contactId: uuid.nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
});
const outcomeSchema = z.object({
  momText: z.string().max(20_000),
  sentiment: z.enum(['positive', 'neutral', 'negative']).nullable().optional(),
  nextSteps: z
    .array(z.object({ action: z.string().max(500), dueDate: z.string().nullable().optional() }))
    .max(20)
    .optional(),
  checkOutAt: position.optional(),
});
const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  repId: userId.optional(),
  atRiskOnly: z.boolean().optional(),
});

const pickerSchema = z.object({
  kind: z.enum(['deal', 'company', 'contact']),
  q: z.string().max(200).optional(),
  companyId: uuid.optional(),
});

export const parsePickerQuery = (q: URLSearchParams) =>
  pickerSchema.parse({
    kind: q.get('kind') ?? undefined,
    q: q.get('q') ?? undefined,
    companyId: q.get('companyId') || undefined,
  });
export const parseCreateBody = (json: unknown) => createSchema.parse(json);
export const parseUpdateBody = (json: unknown) => updateSchema.parse(json);
export const parseCancelBody = (json: unknown) => cancelSchema.parse(json ?? {});
export const parseSiteBody = (json: unknown) => siteSchema.parse(json);
export const parseCheckInBody = (json: unknown) => checkInSchema.parse(json);
export const parsePositionBody = (json: unknown) => position.parse(json);
export const parseWalkInBody = (json: unknown) => walkInSchema.parse(json);
export const parseOutcomeBody = (json: unknown) => outcomeSchema.parse(json);
export const parseDayQuery = (q: URLSearchParams) => {
  const flag = q.get('atRiskOnly');
  return daySchema.parse({
    date: q.get('date') ?? undefined,
    repId: q.get('repId') || undefined,
    atRiskOnly: flag === null ? undefined : flag === 'true' || flag === '1',
  });
};

/** Meeting ids are UUIDs; anything else is simply not found (avoids a DB cast error). */
export function parseMeetingId(id: string): string {
  if (!uuid.safeParse(id).success) throw new FieldError('not_found', 'Meeting not found');
  return id;
}

/** Reads a JSON body; empty body is `{}`; malformed is a validation error. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FieldError('validation', 'Send a JSON body.');
  }
}
