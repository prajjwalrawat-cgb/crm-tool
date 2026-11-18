import { desc, eq, sql } from 'drizzle-orm';

import { dncNumbers, telephonyAccounts, userPhoneMapping } from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { requirePersonas } from '@/lib/personas/guards';
import { listTeammates } from '@/lib/teammates/queries';
import { getTelephonySettings } from '@/lib/telephony/accounts';
import { IMPLEMENTED_PROVIDERS } from '@/lib/telephony/providers';
import { webhookUrl } from '@/lib/telephony/service';

import { TelephonySettingsManager } from './_components/telephony-settings-manager';

export const metadata = { title: 'Telephony · Settings' };

export default async function TelephonySettingsPage() {
  await requirePersonas(['admin']);
  return await withTenantSession(async ({ tenant }) => {
    const data = await tenantTransaction(async (tx) => {
      const settings = await getTelephonySettings(tx, tenant.id);
      const accounts = await tx
        .select({
          id: telephonyAccounts.id,
          provider: telephonyAccounts.provider,
          label: telephonyAccounts.label,
          virtualNumbers: telephonyAccounts.virtualNumbers,
          webhookSecret: telephonyAccounts.webhookSecret,
          isActive: telephonyAccounts.isActive,
        })
        .from(telephonyAccounts)
        .where(eq(telephonyAccounts.tenantId, tenant.id))
        .orderBy(telephonyAccounts.createdAt);
      const mappings = await tx.select().from(userPhoneMapping).where(eq(userPhoneMapping.tenantId, tenant.id));
      const dnc = await tx
        .select()
        .from(dncNumbers)
        .where(eq(dncNumbers.tenantId, tenant.id))
        .orderBy(desc(dncNumbers.addedAt))
        .limit(200);
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(dncNumbers).where(eq(dncNumbers.tenantId, tenant.id));
      return { settings, accounts, mappings, dnc, dncTotal: Number(count?.n ?? 0) };
    });
    const teammates = (await listTeammates(tenant.id, tenant.name)).filter((t) => t.source === 'user');

    return (
      <main className="space-y-4">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">Telephony</h1>
          <p className="mt-0.5 max-w-2xl text-[12px] text-slate-500 dark:text-[#A1A1AA]">
            Connect a cloud telephony account for click-to-call, inbound call matching, recordings and the dialer.
            Exotel is supported today. Credentials are encrypted at rest and never shown again after saving.
          </p>
        </header>
        <TelephonySettingsManager
          kmsConfigured={Boolean(process.env.KMS_KEY)}
          implementedProviders={IMPLEMENTED_PROVIDERS}
          settings={{
            recordCalls: data.settings.recordCalls,
            recordingAnnouncement: data.settings.recordingAnnouncement,
            consentPolicyVersion: data.settings.consentPolicyVersion,
            aiCallSummary: data.settings.aiCallSummary,
            enforceDnc: data.settings.enforceDnc,
            callingHours: data.settings.callingHours,
          }}
          accounts={data.accounts.map((a) => ({
            id: a.id,
            provider: a.provider,
            label: a.label,
            virtualNumbers: a.virtualNumbers,
            isActive: a.isActive,
            webhookUrl: webhookUrl(a.provider, a.id, a.webhookSecret),
          }))}
          members={teammates.map((t) => ({ id: t.id, name: t.displayName, email: t.email }))}
          mappings={data.mappings.map((m) => ({ userId: m.userId, agentPhone: m.agentPhone, agentExt: m.agentExt, agentStatus: m.agentStatus }))}
          dnc={data.dnc.map((d) => ({ phone: d.phoneNormalized, reason: d.reason, addedAt: d.addedAt.toISOString() }))}
          dncTotal={data.dncTotal}
        />
      </main>
    );
  });
}
