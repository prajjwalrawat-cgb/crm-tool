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

/**
 * What was read off the document automatically, before the rep confirmed or
 * corrected it. Stored in `deal_order_proofs.ai_read` (named before the
 * reader moved from an AI model to the PDF's own text).
 */
export type OrderProofAiRead = {
  /** Which reader produced it, e.g. 'pdf-text-v1'. */
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
