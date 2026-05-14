import { z } from 'zod';

import { KNOWN_CURRENCIES } from './currency';

export const DEAL_STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

export const createDealSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(200, 'Name must be 200 characters or fewer'),
  stage: z.enum(DEAL_STAGES, { message: 'Pick a valid stage' }),
  // Major units (e.g. dollars). Coerced from the form text. Server converts
  // to integer minor units before persisting.
  amount: z.coerce
    .number({ message: 'Enter a valid amount' })
    .min(0, 'Amount cannot be negative')
    .max(999_999_999_999, 'Amount is too large'),
  currency: z.enum(KNOWN_CURRENCIES, { message: 'Pick a supported currency' }),
  expectedCloseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date')
    .nullable(),
  companyId: z.uuid({ message: 'Pick a valid company' }).nullable(),
  contactId: z.uuid({ message: 'Pick a valid contact' }).nullable(),
  ownerId: z
    .string()
    .min(1, 'Pick an owner')
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = createDealSchema.extend({
  id: z.uuid({ message: 'Invalid deal id' }),
});

export type UpdateDealInput = z.infer<typeof updateDealSchema>;

export const dealIdSchema = z.object({
  id: z.uuid({ message: 'Invalid deal id' }),
});
