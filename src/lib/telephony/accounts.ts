import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { dncNumbers, telephonyAccounts, telephonySettings, type TelephonySettings } from '@/db/schema';
import { normalizePhone } from '@/lib/lead-capture/normalize';

import { decryptJson } from './crypto';
import { IMPLEMENTED_PROVIDERS } from './providers';
import type { TelephonyAccountContext } from './types';

type DrizzleTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | DrizzleTx;

export const DEFAULT_SETTINGS: Omit<TelephonySettings, 'tenantId' | 'updatedAt'> = {
  recordCalls: true,
  recordingAnnouncement: false,
  consentPolicyVersion: 'v1',
  aiCallSummary: false,
  transcriptionEnabled: false,
  transcriptionConsentAt: null,
  transcriptionConsentBy: null,
  transcriptionProvider: null,
  callingHours: { tz: 'Asia/Kolkata', start: '09:00', end: '21:00' },
  enforceDnc: true,
};

export async function getTelephonySettings(tx: Executor, tenantId: string) {
  const [row] = await tx.select().from(telephonySettings).where(eq(telephonySettings.tenantId, tenantId));
  return row ?? { tenantId, updatedAt: new Date(0), ...DEFAULT_SETTINGS };
}

/** Decrypt one account row into the adapter context. */
export function toAccountContext(row: typeof telephonyAccounts.$inferSelect): TelephonyAccountContext {
  return {
    id: row.id,
    tenantId: row.tenantId,
    provider: row.provider,
    credentials: decryptJson<Record<string, string>>(row.credentialsEncrypted),
    virtualNumbers: row.virtualNumbers ?? [],
    webhookSecret: row.webhookSecret,
  };
}

/** The tenant's dialing account: the oldest active account on an implemented provider. */
export async function getActiveAccountRow(tx: Executor, tenantId: string) {
  const rows = await tx
    .select()
    .from(telephonyAccounts)
    .where(and(eq(telephonyAccounts.tenantId, tenantId), eq(telephonyAccounts.isActive, true)))
    .orderBy(asc(telephonyAccounts.createdAt));
  const allowMock = process.env.TELEPHONY_ALLOW_MOCK === 'true';
  return rows.find((r) => IMPLEMENTED_PROVIDERS.includes(r.provider) || (allowMock && r.provider === 'mock')) ?? null;
}

export async function getAccountRow(tx: Executor, tenantId: string, accountId: string) {
  const [row] = await tx
    .select()
    .from(telephonyAccounts)
    .where(and(eq(telephonyAccounts.id, accountId), eq(telephonyAccounts.tenantId, tenantId)));
  return row ?? null;
}

/** Pre-tenant lookup for webhooks (SECURITY DEFINER fn from 0073). */
export async function lookupAccountForWebhook(accountId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) return null;
  const rows = await db.execute<{ tenant_id: string; provider: string; webhook_secret: string; is_active: boolean }>(
    sql`select * from telephony_account_public_lookup(${accountId}::uuid)`,
  );
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, provider: r.provider, isActive: r.is_active } : null;
}

export async function isDnc(tx: Executor, tenantId: string, phoneNormalized: string | null): Promise<boolean> {
  if (!phoneNormalized) return false;
  const [row] = await tx
    .select({ p: dncNumbers.phoneNormalized })
    .from(dncNumbers)
    .where(and(eq(dncNumbers.tenantId, tenantId), eq(dncNumbers.phoneNormalized, phoneNormalized)));
  return !!row;
}

export async function addDnc(tx: Executor, args: { tenantId: string; phone: string; reason: string | null; addedBy: string | null }) {
  const n = normalizePhone(args.phone);
  if (!n) return null;
  await tx
    .insert(dncNumbers)
    .values({ tenantId: args.tenantId, phoneNormalized: n, reason: args.reason, addedBy: args.addedBy })
    .onConflictDoNothing();
  // Cancel pending dialer items for any lead whose contact has this number.
  await tx.execute(sql`
    update call_campaign_items i set state = 'skipped', skip_reason = 'dnc', locked_by = null, locked_until = null, updated_at = now()
    from deals d left join contacts c on c.id = d.contact_id
    where i.lead_id = d.id and i.tenant_id = ${args.tenantId}
      and i.state in ('pending', 'locked')
      and c.phone_normalized = ${n}`);
  return n;
}

export { parseDncUpload } from './dnc-parse';
