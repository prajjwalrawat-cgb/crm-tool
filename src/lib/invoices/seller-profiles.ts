import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { invoiceSellerProfiles } from '@/db/schema';

import { INDIAN_STATES } from './india-geo';

/**
 * Per-state seller profile (one company, multiple GST registrations). Read on
 * the PI form so the user can pick which state's details to bill from; managed
 * (owner-only) on the Invoice settings page.
 *
 * Accessed via the base `db` connection (not RLS) with an explicit tenant
 * filter on every query — the same pattern as org_invitations. Membership /
 * owner checks live in the action + page layers.
 */
export type SellerProfile = {
  stateCode: string;
  stateName: string;
  name: string;
  address: string;
  gstin: string;
  pan: string;
  cin: string;
  bankName: string;
  bankAccount: string;
  bankIfsc: string;
  bankBranch: string;
};

export function stateNameFromCode(code: string): string {
  return INDIAN_STATES.find((s) => s.code === code)?.name ?? code;
}

type Row = typeof invoiceSellerProfiles.$inferSelect;

function toProfile(r: Row): SellerProfile {
  return {
    stateCode: r.stateCode,
    stateName: stateNameFromCode(r.stateCode),
    name: r.sellerName,
    address: r.address ?? '',
    gstin: r.gstin ?? '',
    pan: r.pan ?? '',
    cin: r.cin ?? '',
    bankName: r.bankName ?? '',
    bankAccount: r.bankAccount ?? '',
    bankIfsc: r.bankIfsc ?? '',
    bankBranch: r.bankBranch ?? '',
  };
}

export async function listSellerProfiles(
  tenantId: string,
): Promise<SellerProfile[]> {
  const rows = await db
    .select()
    .from(invoiceSellerProfiles)
    .where(eq(invoiceSellerProfiles.tenantId, tenantId))
    .orderBy(asc(invoiceSellerProfiles.stateCode));
  return rows.map(toProfile);
}

const clean = (v?: string | null) => (v && v.trim() ? v.trim() : null);

export async function upsertSellerProfile(
  tenantId: string,
  p: SellerProfile,
  userId: string,
): Promise<void> {
  const values = {
    sellerName: p.name.trim(),
    address: clean(p.address),
    gstin: clean(p.gstin),
    pan: clean(p.pan),
    cin: clean(p.cin),
    bankName: clean(p.bankName),
    bankAccount: clean(p.bankAccount),
    bankIfsc: clean(p.bankIfsc),
    bankBranch: clean(p.bankBranch),
    updatedBy: userId,
  };
  await db
    .insert(invoiceSellerProfiles)
    .values({ tenantId, stateCode: p.stateCode, ...values })
    .onConflictDoUpdate({
      target: [invoiceSellerProfiles.tenantId, invoiceSellerProfiles.stateCode],
      set: { ...values, updatedAt: new Date() },
    });
}

export async function deleteSellerProfile(
  tenantId: string,
  stateCode: string,
): Promise<void> {
  await db
    .delete(invoiceSellerProfiles)
    .where(
      and(
        eq(invoiceSellerProfiles.tenantId, tenantId),
        eq(invoiceSellerProfiles.stateCode, stateCode),
      ),
    );
}
