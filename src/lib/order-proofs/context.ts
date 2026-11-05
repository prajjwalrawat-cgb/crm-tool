import 'server-only';

import { and, eq } from 'drizzle-orm';

import { companies, deals, invoiceSellerProfiles, tenants } from '@/db/schema';
import { tenantTransaction, type DbExecutor } from '@/lib/db-context';

import type { ProofCheckContext } from './checks';

/**
 * What a deal's POs are checked against (checks.ts): the deal's company and
 * creation date, and this workspace's own identity — its name, and the
 * seller names and GSTINs on its invoice seller profiles.
 */
export async function proofCheckContext(
  exec: DbExecutor,
  tenantId: string,
  dealId: string,
): Promise<ProofCheckContext | null> {
  const [deal] = await exec
    .select({
      createdAt: deals.createdAt,
      companyName: companies.name,
      companyNameText: deals.companyNameText,
    })
    .from(deals)
    .leftJoin(companies, eq(companies.id, deals.companyId))
    .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)))
    .limit(1);
  if (!deal) return null;
  const [tenant] = await exec
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const sellers = await exec
    .select({ name: invoiceSellerProfiles.sellerName, gstin: invoiceSellerProfiles.gstin })
    .from(invoiceSellerProfiles)
    .where(eq(invoiceSellerProfiles.tenantId, tenantId));
  const names = [tenant?.name, ...sellers.map((s) => s.name)]
    .map((n) => n?.trim())
    .filter((n): n is string => Boolean(n));
  return {
    dealCompany: deal.companyName?.trim() || deal.companyNameText?.trim() || null,
    dealCreatedOn: deal.createdAt.toISOString().slice(0, 10),
    sellerNames: [...new Set(names)],
    sellerGstins: sellers.map((s) => s.gstin?.trim()).filter((g): g is string => Boolean(g)),
  };
}

/** The same, in its own tenant transaction — for the deal page. */
export async function loadProofCheckContext(tenantId: string, dealId: string) {
  return await tenantTransaction((tx) => proofCheckContext(tx, tenantId, dealId));
}
