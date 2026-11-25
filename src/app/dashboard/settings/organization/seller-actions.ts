'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { auth } from '@/lib/auth/server';
import { runWithTenantContext } from '@/lib/db-context';
import { INDIAN_STATES } from '@/lib/invoices/india-geo';
import { deleteSellerProfile, upsertSellerProfile } from '@/lib/invoices/seller-profiles';
import { isOwner, requireMembership } from '@/lib/membership';
import { requireTenant } from '@/lib/tenant';

/**
 * Per-state seller profiles (Settings → Organization → Seller details by
 * state). One list per workspace, used by both invoices and quotes.
 * Owner-only: GSTIN and bank details print on every PI and quote.
 */

export type SellerProfileResult = { ok: true } | { ok: false; error: string };

async function withOwner(
  fn: (ctx: { tenantId: string; userId: string }) => Promise<SellerProfileResult>,
): Promise<SellerProfileResult> {
  const { userId } = await auth();
  if (!userId) return { ok: false, error: 'No active session.' };
  let tenantId: string;
  try {
    tenantId = (await requireTenant()).id;
  } catch {
    return { ok: false, error: 'No active workspace.' };
  }
  return runWithTenantContext({ tenantId, userId }, async () => {
    const membership = await requireMembership().catch(() => null);
    if (!isOwner(membership)) {
      return { ok: false, error: 'Only the workspace owner can change seller details.' };
    }
    return fn({ tenantId, userId });
  });
}

/** Everywhere seller profiles are read. */
function revalidateSellerPages(): void {
  revalidatePath('/dashboard/settings/organization');
  revalidatePath('/dashboard/invoices', 'layout');
  revalidatePath('/dashboard/quotes', 'layout');
}

const opt = (max: number) => z.string().trim().max(max).optional();
const req = (max: number, label: string) => z.string().trim().min(1, `${label} is required`).max(max);

const profileSchema = z.object({
  stateCode: z.string().regex(/^\d{2}$/, 'Pick a state'),
  name: req(200, 'Company name'),
  address: req(600, 'Address'),
  gstin: req(20, 'GSTIN'),
  pan: req(15, 'PAN'),
  cin: opt(30), // optional — not every firm has a CIN
  bankName: req(120, 'Bank name'),
  bankAccount: req(40, 'A/c number'),
  bankIfsc: req(20, 'IFSC'),
  bankBranch: req(120, 'Branch'),
});

export async function saveSellerProfileAction(raw: unknown): Promise<SellerProfileResult> {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Please fix the form.' };
  }
  const p = parsed.data;
  const state = INDIAN_STATES.find((s) => s.code === p.stateCode);
  if (!state) return { ok: false, error: 'Unknown state.' };
  // Keep the GSTIN consistent with the state (its first 2 chars are the code),
  // so tax (IGST vs CGST/SGST) and the printed state line stay correct.
  if (p.gstin.slice(0, 2) !== p.stateCode) {
    return { ok: false, error: `GSTIN for ${state.name} must start with ${p.stateCode}.` };
  }
  return withOwner(async ({ tenantId, userId }) => {
    await upsertSellerProfile(
      tenantId,
      {
        stateCode: p.stateCode,
        stateName: state.name,
        name: p.name,
        address: p.address,
        gstin: p.gstin,
        pan: p.pan,
        cin: p.cin ?? '',
        bankName: p.bankName,
        bankAccount: p.bankAccount,
        bankIfsc: p.bankIfsc,
        bankBranch: p.bankBranch,
      },
      userId,
    );
    revalidateSellerPages();
    return { ok: true };
  });
}

export async function deleteSellerProfileAction(stateCode: string): Promise<SellerProfileResult> {
  if (!/^\d{2}$/.test(stateCode)) return { ok: false, error: 'Invalid state.' };
  return withOwner(async ({ tenantId }) => {
    await deleteSellerProfile(tenantId, stateCode);
    revalidateSellerPages();
    return { ok: true };
  });
}
