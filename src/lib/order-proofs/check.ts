import 'server-only';

import { and, eq } from 'drizzle-orm';

import { dealOrderProofs } from '@/db/schema';
import type { DbExecutor } from '@/lib/db-context';
import type { GateFailure } from '@/lib/stage-gates/types';

import { matchOrderProofs, orderProofProblem, type OrderProofMatch } from './shared';

/**
 * The Won rule (0071): a deal is Won only on the client's order confirmation,
 * and only at the value that confirmation states. Every path into Won — the
 * board, the edit form, AskMiraa — calls `orderProofFailure` first so the user
 * gets an actionable answer; the `deal_order_proof_check` trigger backs it up.
 */

export const ORDER_PROOF_REQUIRED_CODE = 'ORDER_PROOF_REQUIRED';

export async function orderProofMatch(
  exec: DbExecutor,
  deal: { id: string; tenantId: string; amountMinor: number; currency: string },
): Promise<OrderProofMatch> {
  const proofs = await exec
    .select({ subtotalMinor: dealOrderProofs.subtotalMinor, currency: dealOrderProofs.currency })
    .from(dealOrderProofs)
    .where(and(eq(dealOrderProofs.tenantId, deal.tenantId), eq(dealOrderProofs.dealId, deal.id)));
  return matchOrderProofs(deal, proofs);
}

/** The gate-shaped failure for a deal at this value, or null when its proofs match. */
export async function orderProofFailure(
  exec: DbExecutor,
  deal: { id: string; tenantId: string; amountMinor: number; currency: string },
): Promise<GateFailure | null> {
  const message = orderProofProblem(deal, await orderProofMatch(exec, deal));
  if (!message) return null;
  return {
    rule_type: 'order_proof',
    severity: 'block',
    message,
    cta: { label: 'Open order confirmation', kind: 'order_proof' },
  };
}

/**
 * Thrown inside a transaction when a Won deal's value is edited away from its
 * proofs, so the write rolls back. Caught outside and turned into a message.
 */
export class OrderProofMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderProofMismatchError';
  }
}

/** The trigger's error: a write path skipped the check above. */
export function isOrderProofRequiredError(err: unknown): boolean {
  if (!err) return false;
  const direct = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { message?: string } })?.cause?.message ?? '';
  return direct.includes(ORDER_PROOF_REQUIRED_CODE) || cause.includes(ORDER_PROOF_REQUIRED_CODE);
}

export const ORDER_PROOF_FALLBACK_MESSAGE =
  "This deal can't be Won at this value: its order confirmation (PO) is missing or doesn't match the deal value. Check the Order confirmation card on the deal.";
