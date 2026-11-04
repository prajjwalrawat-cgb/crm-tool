/**
 * Order-proof vocabulary (0071), dependency-free so the schema, the server
 * and client components can all import it without pulling in the database.
 */

export const ORDER_PROOF_TYPES = [
  'purchase_order',
  'work_order',
  'signed_contract',
  'letter_of_intent',
  'email_confirmation',
  'other',
] as const;
export type OrderProofType = (typeof ORDER_PROOF_TYPES)[number];

/** What the AI read off the document, before the rep confirmed or corrected it. */
export type OrderProofAiRead = {
  model: string;
  referenceNo: string | null;
  issuedOn: string | null;
  buyerName: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string | null;
};
