import { z } from 'zod';

/**
 * Validation shared by the create form (frontend) and the server action
 * (backend). The form parses with this for inline errors; the action
 * re-parses the same schema as the authoritative gate — never trust the
 * client. No `server-only` marker so the client can import it too.
 */

// Empty strings from form inputs collapse to undefined before validation.
const optStr = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );

export const partySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  address: optStr(600),
  city: optStr(100),
  /** Locality / area within the city (e.g. Dwarka). */
  locality: optStr(120),
  /** Postal PIN code. */
  pincode: optStr(12),
  gstin: optStr(20),
  state: optStr(100),
  /** GST state code (auto-derived from state). */
  stateCode: optStr(6),
});

export const sellerSchema = partySchema.extend({
  pan: optStr(15),
  cin: optStr(30),
  bankName: optStr(120),
  bankAccount: optStr(40),
  bankIfsc: optStr(20),
  bankBranch: optStr(120),
});

export const invoiceItemSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(300),
  hsnSac: optStr(20),
  unit: z.string().trim().min(1).max(10).default('No'),
  quantity: z.coerce
    .number({ message: 'Qty must be a number' })
    .int('Whole numbers only')
    .min(1, 'Min 1')
    .max(1_000_000),
  // Rate in rupees (major units); converted to paise on the server.
  rate: z.coerce
    .number({ message: 'Rate must be a number' })
    .min(0, 'Cannot be negative')
    .max(1_000_000_000),
  // Public Supabase Storage URL for the line's product image (optional).
  imageUrl: optStr(1000),
});

export const createInvoiceSchema = z.object({
  piDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a valid date'),
  currency: z.string().trim().min(1).max(8).default('INR'),
  seller: sellerSchema,
  buyer: partySchema,
  consigneeSameAsBuyer: z.boolean().default(true),
  consignee: partySchema.optional(),
  paymentTerms: optStr(300),
  deliveryTerms: optStr(300),
  notes: optStr(1000),
  taxRate: z.coerce
    .number({ message: 'Tax % must be a number' })
    .min(0, 'Min 0')
    .max(100, 'Max 100'),
  items: z
    .array(invoiceItemSchema)
    .min(1, 'Add at least one line item')
    .max(100, 'Too many line items'),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;
export type PartyInput = z.infer<typeof partySchema>;
export type SellerInput = z.infer<typeof sellerSchema>;
