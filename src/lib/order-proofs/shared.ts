import type { OrderProofType } from './types';
import { formatCurrency } from '@/lib/deals/currency';

/**
 * Client- and server-safe rules for order proofs (0071). The server actions,
 * the deal page card and the database trigger all agree on one definition of
 * "the PO matches the deal".
 */

/**
 * Rounding the match allows, in minor units (₹1 / $1). Must equal the `100`
 * in the `deal_order_proof_check` trigger.
 */
export const ORDER_PROOF_ROUNDING_MINOR = 100;

export const ORDER_PROOF_TYPE_LABELS: Record<OrderProofType, string> = {
  purchase_order: 'Purchase order',
  work_order: 'Work order',
  signed_contract: 'Signed contract',
  letter_of_intent: 'Letter of intent',
  email_confirmation: 'Email confirmation',
  other: 'Other order proof',
};

/** File types a proof may be: what the AI can read, and what a scan comes as. */
export const ORDER_PROOF_FILE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const ORDER_PROOF_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type ProofValue = { subtotalMinor: number; currency: string };

export type OrderProofMatch =
  /** No proof on the deal at all. */
  | { state: 'none' }
  /** A proof is in another currency than the deal. */
  | { state: 'currency'; currencies: string[] }
  /** Proofs and deal disagree. `gapMinor` > 0: the PO is worth MORE than the deal. */
  | { state: 'gap'; proofMinor: number; gapMinor: number }
  | { state: 'match'; proofMinor: number };

export function matchOrderProofs(
  deal: { amountMinor: number; currency: string },
  proofs: ProofValue[],
): OrderProofMatch {
  if (proofs.length === 0) return { state: 'none' };
  const others = proofs.filter((p) => p.currency !== deal.currency);
  if (others.length > 0) {
    return { state: 'currency', currencies: [...new Set(others.map((p) => p.currency))] };
  }
  const proofMinor = proofs.reduce((sum, p) => sum + p.subtotalMinor, 0);
  const gapMinor = proofMinor - deal.amountMinor;
  if (Math.abs(gapMinor) <= ORDER_PROOF_ROUNDING_MINOR) return { state: 'match', proofMinor };
  return { state: 'gap', proofMinor, gapMinor };
}

/**
 * Why a deal can't be Won, in words a rep (or AskMira's assistant) can act on.
 * Null when the proofs match.
 */
export function orderProofProblem(
  deal: { amountMinor: number; currency: string },
  match: OrderProofMatch,
): string | null {
  switch (match.state) {
    case 'match':
      return null;
    case 'none':
      return "Attach the client's PO (or other order confirmation) before marking this deal Won.";
    case 'currency':
      return `The order proof is in ${match.currencies.join(', ')} but the deal is in ${deal.currency}. Remove it, or change the deal's currency to match the PO.`;
    case 'gap': {
      const po = formatCurrency(match.proofMinor, deal.currency);
      const value = formatCurrency(deal.amountMinor, deal.currency);
      const gap = formatCurrency(Math.abs(match.gapMinor), deal.currency);
      return match.gapMinor > 0
        ? `The deal value (${value}) is ${gap} less than the PO value before tax (${po}). Make the deal value match the PO.`
        : `The deal value (${value}) is ${gap} more than the PO value before tax (${po}). Make the deal value match the PO, or attach the missing PO.`;
    }
  }
}
