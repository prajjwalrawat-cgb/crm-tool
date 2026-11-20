/**
 * Zod input schemas for the quote data layer. Pure (zod only): the editor
 * can parse with these for inline errors; the server re-parses as the gate.
 */
import { z } from 'zod';

import { richTextDocSchema } from './rich-text';

const isoDate = z.iso.date({ message: 'Use a valid date' });

const optText = (max: number) => z.string().trim().max(max).optional();

/** PdfParty plus the buyer contact prefilled from the deal. */
export const quotePartySchema = z.object({
  name: z.string().trim().max(200),
  address: optText(600),
  city: optText(100),
  locality: optText(100),
  pincode: optText(12),
  gstin: optText(20),
  state: optText(100),
  stateCode: z.string().regex(/^\d{2}$/, 'Select a state').optional(),
  contactName: optText(200),
  contactEmail: optText(200),
});

export const quoteItemInputSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(2000),
  hsnSac: optText(20),
  unit: optText(20),
  quantity: z
    .number({ message: 'Qty must be a number' })
    .gt(0, 'Qty must be more than 0')
    .max(99_999_999_999)
    .refine((n) => Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6, 'Up to 3 decimal places'),
  rateMinor: z.number().int().min(0),
  discountBps: z.number().int().min(0).max(10_000),
  taxRateBps: z.number().int().min(0).max(4_000),
  offeringId: z.uuid().optional(),
  groupLabel: optText(200),
});

export const overallDiscountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('amount'), valueMinor: z.number().int().min(0) }),
  z.object({ type: z.literal('percent'), bps: z.number().int().min(0).max(10_000) }),
]);

export const sectionContentSchema = z.object({
  text: richTextDocSchema.optional(),
  terms: richTextDocSchema.optional(),
  milestones: z
    .array(z.object({ label: z.string().trim().min(1).max(200), percentBps: z.number().int().min(0).max(10_000) }))
    .max(50)
    .optional(),
});

/** Milestones, when given, need at least one row and must add up to exactly 100% (10000 bps). */
export const quoteContentSchema = z.record(z.string(), sectionContentSchema).superRefine((content, ctx) => {
  for (const [sectionId, c] of Object.entries(content)) {
    if (!c.milestones) continue;
    const sum = c.milestones.reduce((a, m) => a + m.percentBps, 0);
    if (c.milestones.length === 0) {
      ctx.addIssue({ code: 'custom', path: [sectionId, 'milestones'], message: 'Add at least one milestone' });
    } else if (sum !== 10_000) {
      ctx.addIssue({ code: 'custom', path: [sectionId, 'milestones'], message: `Milestones must add up to 100% (now ${sum / 100}%)` });
    }
  }
});

export const quoteDraftInputSchema = z
  .object({
    quoteDate: isoDate,
    validUntil: isoDate,
    /** null = the workspace invoice seller (organization settings) instead of a profile. */
    sellerProfileId: z.uuid().nullable(),
    buyer: quotePartySchema.extend({ name: z.string().trim().min(1, 'Name is required').max(200) }),
    consignee: quotePartySchema.nullable(),
    items: z.array(quoteItemInputSchema).min(1, 'Add at least one line item').max(200, 'Too many line items'),
    overallDiscount: overallDiscountSchema,
    content: quoteContentSchema,
  })
  .refine((v) => v.validUntil >= v.quoteDate, {
    path: ['validUntil'],
    message: 'Valid until must be on or after the quote date',
  });

export type QuoteDraftInput = z.infer<typeof quoteDraftInputSchema>;
export type QuoteItemInput = z.infer<typeof quoteItemInputSchema>;

export const quoteSettingsInputSchema = z.object({
  numberPrefix: z.string().trim().min(1, 'Prefix is required').max(20).regex(/^\S+$/, 'No spaces'),
  numberSeparator: z.string().max(3).regex(/^\S*$/, 'No spaces'),
  numberIncludeFy: z.boolean(),
  numberPadding: z.number().int().min(1).max(8),
  defaultValidityDays: z.number().int().min(1).max(365),
});

export type QuoteSettingsInput = z.infer<typeof quoteSettingsInputSchema>;
