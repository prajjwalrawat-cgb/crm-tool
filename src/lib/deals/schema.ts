import { z } from 'zod';

import { KNOWN_CURRENCIES } from './currency';
import { MARGIN_REQUIRED_MESSAGE, violatesMissingMargin } from './validation';

export const DEAL_STAGES = [
  'lead',
  'qualified',
  'proposal',
  'negotiation',
  'hold',
  'won',
  'lost',
] as const;

export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: 'Lead',
  qualified: 'Qualified',
  proposal: 'Proposal',
  negotiation: 'Negotiation',
  hold: 'Hold',
  won: 'Won',
  lost: 'Lost',
};

/** Deal classification — distinguishes same-named opportunities. */
export const DEAL_TYPES = ['new_logo', 'renewal', 'expansion', 'upsell'] as const;
export type DealType = (typeof DEAL_TYPES)[number];
export const DEAL_TYPE_LABELS: Record<DealType, string> = {
  new_logo: 'New Logo',
  renewal: 'Renewal',
  expansion: 'Expansion',
  upsell: 'Upsell',
};

const dealFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(200, 'Name must be 200 characters or fewer'),
  description: z
    .string()
    .trim()
    .max(2000, 'Description must be 2000 characters or fewer')
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  stage: z.enum(DEAL_STAGES, { message: 'Pick a valid stage' }),
  // Major units (e.g. dollars). Coerced from the form text. Server converts
  // to integer minor units before persisting.
  amount: z.coerce
    .number({ message: 'Enter a valid amount' })
    .min(0, 'Amount cannot be negative')
    .max(999_999_999_999, 'Amount is too large'),
  // Optional per-unit pricing (only sent when the workspace enables it).
  // Amount is recomputed from these server-side when both are present.
  unitPrice: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.coerce
      .number({ message: 'Unit price must be a number' })
      .min(0, 'Cannot be negative')
      .max(999_999_999_999)
      .optional(),
  ),
  quantity: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.coerce
      .number({ message: 'Qty must be a number' })
      .int('Whole numbers only')
      .min(0)
      .max(1_000_000)
      .optional(),
  ),
  // Gross margin percentage — 0–100, up to 2 decimals, stored as basis points
  // server-side (margin value = amount × margin%). Optional at the SHAPE level
  // and made mandatory per-stage by `checkMarginForStage` below: a Lead is
  // saved without one because the rep doesn't know it yet.
  marginPct: z.preprocess(
    (v) => (v == null || v === '' ? undefined : v),
    z.coerce
      .number({ message: 'Enter a valid margin' })
      .gt(0, 'Margin must be greater than 0')
      .max(100, 'Margin cannot exceed 100%')
      .optional(),
  ),
  currency: z.enum(KNOWN_CURRENCIES, { message: 'Pick a supported currency' }),
  // Optional deal classification. Empty string from the form → null.
  dealType: z.preprocess(
    (v) => (v == null || v === '' ? null : v),
    z.enum(DEAL_TYPES).nullable(),
  ),
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

/**
 * Margin is mandatory from Qualified onwards and optional in Lead — the rule
 * spans two fields, so it's a whole-object check rather than a field rule. The
 * issue is filed against `marginPct` so the form highlights the input.
 */
function checkMarginForStage(
  data: { stage: string; marginPct?: number },
  ctx: z.RefinementCtx,
): void {
  if (violatesMissingMargin(data.stage, data.marginPct)) {
    ctx.addIssue({
      code: 'custom',
      path: ['marginPct'],
      message: MARGIN_REQUIRED_MESSAGE,
    });
  }
}

export const createDealSchema = dealFormSchema.superRefine(checkMarginForStage);

export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = dealFormSchema
  .extend({ id: z.uuid({ message: 'Invalid deal id' }) })
  .superRefine(checkMarginForStage);

export type UpdateDealInput = z.infer<typeof updateDealSchema>;

/**
 * Partial single/multi-field update for inline (click-to-edit) table cells.
 * Every field is optional; only the keys present are written. `null` clears a
 * nullable field. Stage is intentionally NOT here — it keeps its own action so
 * stage-change automation/activity stays intact.
 */
export const patchDealSchema = z.object({
  id: z.uuid({ message: 'Invalid deal id' }),
  name: z.string().trim().min(1, 'Name is required').max(200).optional(),
  amount: z.coerce
    .number({ message: 'Enter a valid amount' })
    .min(0, 'Amount cannot be negative')
    .max(999_999_999_999, 'Amount is too large')
    .optional(),
  currency: z.enum(KNOWN_CURRENCIES).optional(),
  expectedCloseDate: z
    .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date'), z.null()])
    .optional(),
  /**
   * Optional "why is this pushed back?" note that rides along with a close-date
   * change. NOT a deal column — the action hands it to the pushback trigger,
   * which stores it on the `deal_date_changes` row it writes. Never blocking:
   * an absent or empty reason still saves the date.
   */
  closeDateChangeReason: z
    .union([z.string().trim().max(500, 'Keep the reason under 500 characters'), z.null()])
    .optional(),
  // Same bounds the create/edit forms enforce.
  marginPct: z.coerce
    .number({ message: 'Enter a valid margin' })
    .gt(0, 'Margin must be greater than 0')
    .max(100, 'Margin cannot exceed 100%')
    .optional(),
  dealType: z.union([z.enum(DEAL_TYPES), z.null()]).optional(),
  // Unit pricing: either side may be patched alone; the action fills the other
  // from the stored row and re-derives the amount.
  unitPrice: z.coerce
    .number({ message: 'Enter a valid unit price' })
    .min(0, 'Unit price cannot be negative')
    .max(999_999_999_999, 'Unit price is too large')
    .optional(),
  quantity: z.coerce
    .number({ message: 'Enter a valid quantity' })
    .int('Quantity must be a whole number')
    .min(0, 'Quantity cannot be negative')
    .max(100_000_000, 'Quantity is too large')
    .optional(),
  companyName: z.union([z.string().trim().max(200), z.null()]).optional(),
  contactName: z.union([z.string().trim().max(200), z.null()]).optional(),
  contactEmail: z
    .union([
      z
        .string()
        .trim()
        .max(200)
        .refine(
          (v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
          'Enter a valid email',
        ),
      z.null(),
    ])
    .optional(),
  // Linked records (inline dropdown edits). Validated against tenant + scope.
  companyId: z.union([z.uuid(), z.null()]).optional(),
  contactId: z.union([z.uuid(), z.null()]).optional(),
  ownerId: z.union([z.string().min(1).max(120), z.null()]).optional(),
});

export type PatchDealInput = z.infer<typeof patchDealSchema>;

export const dealIdSchema = z.object({
  id: z.uuid({ message: 'Invalid deal id' }),
});
