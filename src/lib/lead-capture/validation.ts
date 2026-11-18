import { z } from 'zod';

import {
  CONDITION_OPS,
  DISTRIBUTION_STRATEGIES,
  LEAD_SOURCE_TYPES,
  WEEKDAYS,
} from './constants';

import { LEAD_FIELD_KEYS } from './mapping';
import { validateWorkingHours } from './working-hours';

/**
 * Zod schemas for every lead-capture admin input. Shared by the server
 * actions and the REST route handlers so both validate identically. Pure.
 */

const userId = z.string().trim().min(1).max(200);

const mappingTarget = z
  .string()
  .trim()
  .refine(
    (t) => (LEAD_FIELD_KEYS as readonly string[]).includes(t) || /^custom\.[a-z0-9_]{1,64}$/.test(t),
    'Map to a lead field or custom.<key>',
  );

export const fieldMappingSchema = z
  .record(z.string().trim().min(1).max(200), mappingTarget)
  .refine((m) => Object.keys(m).length <= 200, 'Too many mapped fields');

const origin = z
  .string()
  .trim()
  .url('Each allowed origin must be a URL like https://example.com')
  .transform((u) => new URL(u).origin);

export const leadSourceInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the source a name').max(120),
  type: z.enum(LEAD_SOURCE_TYPES),
  fieldMapping: fieldMappingSchema.default({}),
  defaultRuleId: z.string().uuid().nullable().default(null),
  allowedOrigins: z.array(origin).max(20).default([]),
  config: z
    .object({
      page_id: z.string().trim().max(64).optional(),
      form_ids: z.array(z.string().trim().max(64)).max(50).optional(),
      page_token: z.string().trim().max(1000).optional(),
    })
    .default({}),
});
export type LeadSourceInput = z.infer<typeof leadSourceInputSchema>;

export const ruleConditionSchema = z.object({
  field: z.string().trim().min(1).max(100),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(100)]).optional(),
});

export const distributionRuleInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the rule a name').max(120),
    conditions: z.array(ruleConditionSchema).max(20).default([]),
    strategy: z.enum(DISTRIBUTION_STRATEGIES),
    pool: z.object({
      user_ids: z.array(userId).max(200).default([]),
      weights: z.record(userId, z.number().int().min(0).max(100)).optional(),
      fixed_owner_id: userId.optional(),
    }),
    capacityCap: z.number().int().min(1).max(10_000).nullable().default(null),
    respectAvailability: z.boolean().default(true),
    slaMinutes: z.number().int().min(1).max(10_080).default(30),
    maxReassignments: z.number().int().min(0).max(10).default(2),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.strategy === 'fixed_owner' && !r.pool.fixed_owner_id) {
      ctx.addIssue({ code: 'custom', path: ['pool', 'fixed_owner_id'], message: 'Pick the fixed owner' });
    }
    if (r.strategy !== 'fixed_owner' && r.pool.user_ids.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['pool', 'user_ids'], message: 'Add at least one person to the pool' });
    }
  });
export type DistributionRuleInput = z.infer<typeof distributionRuleInputSchema>;

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM');
export const workingHoursSchema = z
  .object({
    tz: z.string().trim().min(1).max(64),
    days: z.partialRecord(z.enum(WEEKDAYS), z.tuple([hhmm, hhmm])),
  })
  .superRefine((wh, ctx) => {
    const err = validateWorkingHours(wh);
    if (err) ctx.addIssue({ code: 'custom', message: err });
  });

export const routingProfileInputSchema = z.object({
  userId,
  isAvailable: z.boolean(),
  workingHours: workingHoursSchema.nullable(),
  skills: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  regions: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});
export type RoutingProfileInput = z.infer<typeof routingProfileInputSchema>;

export const captureFormFieldSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/, 'Field keys are lower_snake_case'),
  label: z.string().trim().min(1).max(200),
  type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox']),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  validation: z.object({ pattern: z.string().max(200).optional(), maxLength: z.number().int().min(1).max(5000).optional() }).optional(),
});

export const captureFormInputSchema = z.object({
  sourceId: z.string().uuid(),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, numbers and dashes'),
  title: z.string().trim().min(1).max(200),
  fields: z
    .array(captureFormFieldSchema)
    .min(1, 'Add at least one field')
    .max(40)
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Field keys must be unique')
    .refine((f) => f.some((x) => x.type === 'email' || x.type === 'tel'), 'A form needs an email or phone field'),
  thankYouMessage: z.string().trim().max(1000).nullable().default(null),
  redirectUrl: z.string().trim().url().nullable().default(null),
  consentText: z.string().trim().max(2000).nullable().default(null),
  theme: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).default({}),
});
export type CaptureFormInput = z.infer<typeof captureFormInputSchema>;

export const simulateInputSchema = z.object({
  sourceId: z.string().uuid().nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  state: z.string().max(120).nullable().optional(),
  productInterest: z.string().max(300).nullable().optional(),
  company: z.string().max(300).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  utmSource: z.string().max(200).nullable().optional(),
  utmMedium: z.string().max(200).nullable().optional(),
  utmCampaign: z.string().max(200).nullable().optional(),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const reassignInputSchema = z.object({
  to: userId,
  reason: z.string().trim().max(500).nullable().default(null),
});
