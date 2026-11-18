'use server';

import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  AGENT_STATUSES,
  CALL_DISPOSITIONS,
  TELEPHONY_PROVIDERS,
  dncNumbers,
  telephonyAccounts,
  telephonySettings,
  userPhoneMapping,
  type MembershipRole,
} from '@/db/schema';
import { withTenantSession } from '@/lib/auth-guard';
import { tenantTransaction } from '@/lib/db-context';
import { normalizePhone } from '@/lib/lead-capture/normalize';
import { sendWorkflowEvent } from '@/lib/inngest/send';
import { requireMembership } from '@/lib/membership';
import { canRetryTranscription } from '@/lib/telephony/transcription';
import { getTranscriber, STT_PROVIDER_LABELS } from '@/lib/telephony/transcriber';
import { defaultAppliers } from '@/lib/ai/suggestions/appliers';
import { decideSuggestion, pendingFollowUpForCall } from '@/lib/ai/suggestions/service';
import { addDnc, getActiveAccountRow } from '@/lib/telephony/accounts';
import { validateCallingHours } from '@/lib/telephony/calling-hours';
import {
  claimNextItem,
  createCampaign,
  dialClaimedItem,
  setCampaignStatus,
  skipClaimedItem,
} from '@/lib/telephony/campaigns';
import { encryptJson, generateWebhookSecret, MissingKmsKeyError } from '@/lib/telephony/crypto';
import { parseDncUpload } from '@/lib/telephony/dnc-parse';
import { serializeCall, type SerializedCall } from '@/lib/telephony/serialize';
import { acceptFollowUp, clickToCall, getAgentState, getCallScoped, saveDisposition, setAgentStatus, SKIP_DISPOSITION_MAX_SEC } from '@/lib/telephony/service';
import { TelephonyError } from '@/lib/telephony/types';

/**
 * Server actions behind the softphone bar, click-to-call buttons, the
 * disposition modal, Settings → Telephony and the dialer. Every action runs
 * in the caller's tenant context; settings actions are admin/owner only,
 * campaign management manager and up.
 */

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; code?: string; message: string };

const isAdmin = (r: MembershipRole) => r === 'owner' || r === 'admin';
const isManager = (r: MembershipRole) => r === 'owner' || r === 'admin' || r === 'manager';

async function session<T>(fn: (v: { tenantId: string; userId: string; role: MembershipRole }) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await withTenantSession(async ({ tenant, userId }) => {
      const m = await requireMembership();
      return await fn({ tenantId: tenant.id, userId, role: m.role });
    });
  } catch (err) {
    if (err instanceof TelephonyError) return { ok: false, code: err.code, message: err.message };
    if (err instanceof MissingKmsKeyError) return { ok: false, code: 'kms', message: err.message };
    throw err;
  }
}

/* --------------------------------------------------------------- softphone */

export type SoftphoneState = {
  configured: boolean;
  mapped: boolean;
  agentStatus: (typeof AGENT_STATUSES)[number];
  activeCall: SerializedCall | null;
  pendingDisposition: SerializedCall | null;
  leadName: string | null;
  skipMaxSec: number;
};

export async function getSoftphoneState(): Promise<ActionResult<{ state: SoftphoneState }>> {
  return session<{ state: SoftphoneState }>(async ({ tenantId, userId }) => {
    const s = await getAgentState(tenantId, userId);
    return {
      ok: true,
      state: {
        configured: s.configured,
        mapped: s.mapped,
        agentStatus: s.agentStatus,
        activeCall: s.activeCall ? serializeCall(s.activeCall) : null,
        pendingDisposition: s.pendingDisposition ? serializeCall(s.pendingDisposition) : null,
        leadName: s.leadName,
        skipMaxSec: SKIP_DISPOSITION_MAX_SEC,
      },
    };
  });
}

export async function setMyAgentStatus(status: string): Promise<ActionResult> {
  const parsed = z.enum(AGENT_STATUSES).safeParse(status);
  if (!parsed.success) return { ok: false, message: 'Unknown status.' };
  return session<object>(async ({ tenantId, userId }) => {
    const r = await setAgentStatus(tenantId, userId, parsed.data);
    return r.ok ? { ok: true } : { ok: false, message: r.error ?? 'Could not change status.' };
  });
}

const StartCall = z.object({
  leadId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  phone: z.string().max(40).nullish(),
  overrideHours: z.boolean().optional(),
});

export async function startCall(input: z.infer<typeof StartCall>): Promise<ActionResult<{ callId: string }>> {
  const parsed = StartCall.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid call request.' };
  return session<{ callId: string }>(async (v) => {
    const { callId } = await clickToCall({ ...v, ...parsed.data });
    return { ok: true, callId };
  });
}

const Disposition = z.object({
  callId: z.string().uuid(),
  disposition: z.enum(CALL_DISPOSITIONS),
  notes: z.string().max(5000).nullish(),
  callbackAt: z.string().nullish(),
});

export async function submitDisposition(input: z.infer<typeof Disposition>): Promise<ActionResult<{ taskId: string | null }>> {
  const parsed = Disposition.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Pick a disposition.' };
  const callbackAt = parsed.data.callbackAt ? new Date(parsed.data.callbackAt) : null;
  if (callbackAt && Number.isNaN(callbackAt.getTime())) return { ok: false, message: 'Invalid callback time.' };
  return session<{ taskId: string | null }>(async (v) => {
    const r = await saveDisposition({ ...v, callId: parsed.data.callId, disposition: parsed.data.disposition, notes: parsed.data.notes ?? null, callbackAt });
    if (!r.ok) return { ok: false, message: r.error };
    revalidatePath('/dashboard/deals');
    return { ok: true, taskId: r.taskId };
  });
}

/** Retry a failed or skipped transcription (runs the job again; the job re-checks settings). */
export async function retryCallTranscription(callId: string): Promise<ActionResult> {
  if (!z.string().uuid().safeParse(callId).success) return { ok: false, message: 'Invalid call.' };
  return session<object>(async (v) => {
    const r = await canRetryTranscription({ tenantId: v.tenantId, viewer: { userId: v.userId, role: v.role }, callId });
    if (!r.ok) return { ok: false, message: r.error };
    await sendWorkflowEvent('crm/call.transcribe_requested', { tenantId: v.tenantId, callId, requestedBy: v.userId });
    return { ok: true };
  });
}

export async function acceptCallFollowUp(callId: string): Promise<ActionResult<{ taskId: string }>> {
  return session<{ taskId: string }>(async (v) => {
    // One review mechanism: when the call's follow-up is a pending AI
    // suggestion, accept that (it creates the task through the task action
    // and records the decision). Older calls without one use the direct path.
    const suggestionId = await pendingFollowUpForCall(v.tenantId, callId);
    if (suggestionId) {
      const d = await decideSuggestion({ tenantId: v.tenantId, viewer: { userId: v.userId, role: v.role }, id: suggestionId, action: 'accept' }, defaultAppliers);
      if (!d.ok) return { ok: false, message: d.message };
      const taskId = (await getCallScoped(v.tenantId, { userId: v.userId, role: v.role }, callId))?.followUpTaskId;
      revalidatePath('/dashboard/tasks');
      revalidatePath('/dashboard/suggestions');
      return taskId ? { ok: true, taskId } : { ok: false, message: 'Follow-up task was not linked to the call.' };
    }
    const r = await acceptFollowUp({ ...v, callId });
    if (!r.ok) return { ok: false, message: r.error };
    revalidatePath('/dashboard/tasks');
    return { ok: true, taskId: r.taskId };
  });
}

/* ---------------------------------------------------------------- settings */

const AccountInput = z.object({
  id: z.string().uuid().nullish(),
  provider: z.enum(TELEPHONY_PROVIDERS),
  label: z.string().max(100).nullish(),
  accountSid: z.string().max(200).optional(),
  apiKey: z.string().max(200).optional(),
  apiToken: z.string().max(400).optional(),
  subdomain: z.string().max(100).optional(),
  virtualNumbers: z.array(z.string().max(40)).min(1).max(20),
  isActive: z.boolean().default(true),
});

export async function saveTelephonyAccount(input: z.infer<typeof AccountInput>): Promise<ActionResult<{ id: string }>> {
  const parsed = AccountInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid account.' };
  return session<{ id: string }>(async ({ tenantId, userId, role }) => {
    if (!isAdmin(role)) return { ok: false, message: 'Only admins can manage telephony.' };
    const d = parsed.data;
    const numbers = d.virtualNumbers.map((n) => normalizePhone(n));
    if (numbers.some((n) => !n)) return { ok: false, message: 'Every caller id must be a valid phone number.' };
    const id = await tenantTransaction(async (tx) => {
      const existing = d.id
        ? (await tx.select().from(telephonyAccounts).where(and(eq(telephonyAccounts.id, d.id), eq(telephonyAccounts.tenantId, tenantId))))[0]
        : undefined;
      const hasNewCreds = !!(d.accountSid || d.apiKey || d.apiToken);
      if (!existing && !hasNewCreds) throw new TelephonyError('Enter the account credentials.', 'not_configured');
      const credentials = hasNewCreds
        ? encryptJson({ accountSid: d.accountSid ?? '', apiKey: d.apiKey ?? '', apiToken: d.apiToken ?? '', subdomain: d.subdomain || 'api.exotel.com' })
        : existing!.credentialsEncrypted;
      if (existing) {
        await tx
          .update(telephonyAccounts)
          .set({ provider: d.provider, label: d.label ?? null, credentialsEncrypted: credentials, virtualNumbers: numbers as string[], isActive: d.isActive })
          .where(eq(telephonyAccounts.id, existing.id));
        return existing.id;
      }
      const [row] = await tx
        .insert(telephonyAccounts)
        .values({
          tenantId,
          provider: d.provider,
          label: d.label ?? null,
          credentialsEncrypted: credentials,
          virtualNumbers: numbers as string[],
          webhookSecret: generateWebhookSecret(),
          isActive: d.isActive,
          createdBy: userId,
        })
        .returning({ id: telephonyAccounts.id });
      return row!.id;
    });
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true, id };
  });
}

export async function rotateWebhookSecret(accountId: string): Promise<ActionResult> {
  return session<object>(async ({ tenantId, role }) => {
    if (!isAdmin(role)) return { ok: false, message: 'Only admins can manage telephony.' };
    await tenantTransaction((tx) =>
      tx
        .update(telephonyAccounts)
        .set({ webhookSecret: generateWebhookSecret() })
        .where(and(eq(telephonyAccounts.id, accountId), eq(telephonyAccounts.tenantId, tenantId))),
    );
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true };
  });
}

const SettingsInput = z.object({
  recordCalls: z.boolean(),
  recordingAnnouncement: z.boolean(),
  consentPolicyVersion: z.string().min(1).max(40),
  aiCallSummary: z.boolean(),
  /** 'off' = no transcription. */
  transcriptionProvider: z.enum(['off', 'deepgram', 'sarvam']),
  /** The admin's confirmation that callers are told about recording/transcription. */
  transcriptionConsent: z.boolean(),
  enforceDnc: z.boolean(),
  callingHours: z.object({ tz: z.string(), start: z.string(), end: z.string() }),
});

export async function saveTelephonySettings(input: z.infer<typeof SettingsInput>): Promise<ActionResult> {
  const parsed = SettingsInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Invalid settings.' };
  const hoursErr = validateCallingHours(parsed.data.callingHours);
  if (hoursErr) return { ok: false, message: `Calling hours: ${hoursErr}` };
  const provider = parsed.data.transcriptionProvider === 'off' ? null : parsed.data.transcriptionProvider;
  if (provider && !parsed.data.transcriptionConsent) {
    return { ok: false, message: 'Confirm the recording-consent statement before turning on transcription.' };
  }
  if (provider && !getTranscriber(provider).configured()) {
    return { ok: false, message: `The ${STT_PROVIDER_LABELS[provider] ?? provider} API key is not set on the server yet.` };
  }
  return session<object>(async ({ tenantId, userId, role }) => {
    if (!isAdmin(role)) return { ok: false, message: 'Only admins can manage telephony.' };
    const { transcriptionConsent, transcriptionProvider: _choice, ...rest } = parsed.data;
    void _choice;
    await tenantTransaction(async (tx) => {
      const [current] = await tx
        .select({ consentAt: telephonySettings.transcriptionConsentAt, consentBy: telephonySettings.transcriptionConsentBy })
        .from(telephonySettings)
        .where(eq(telephonySettings.tenantId, tenantId));
      // Keep the original confirmation time/actor; clear it when unticked.
      const consent = transcriptionConsent
        ? { transcriptionConsentAt: current?.consentAt ?? new Date(), transcriptionConsentBy: current?.consentAt ? current.consentBy : userId }
        : { transcriptionConsentAt: null, transcriptionConsentBy: null };
      const values = { ...rest, ...consent, transcriptionProvider: provider, transcriptionEnabled: provider !== null };
      await tx
        .insert(telephonySettings)
        .values({ tenantId, ...values })
        .onConflictDoUpdate({ target: telephonySettings.tenantId, set: { ...values, updatedAt: new Date() } });
    });
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true };
  });
}

export async function mapUserPhone(input: { userId: string; agentPhone: string; agentExt?: string | null }): Promise<ActionResult> {
  const phone = normalizePhone(input.agentPhone);
  if (!phone) return { ok: false, message: 'Enter a valid phone number.' };
  return session<object>(async ({ tenantId, role }) => {
    if (!isAdmin(role)) return { ok: false, message: 'Only admins can manage telephony.' };
    await tenantTransaction((tx) =>
      tx
        .insert(userPhoneMapping)
        .values({ tenantId, userId: input.userId, agentPhone: phone, agentExt: input.agentExt ?? null })
        .onConflictDoUpdate({
          target: [userPhoneMapping.tenantId, userPhoneMapping.userId],
          set: { agentPhone: phone, agentExt: input.agentExt ?? null, updatedAt: new Date() },
        }),
    );
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true };
  });
}

export async function unmapUserPhone(userId: string): Promise<ActionResult> {
  return session<object>(async ({ tenantId, role }) => {
    if (!isAdmin(role)) return { ok: false, message: 'Only admins can manage telephony.' };
    await tenantTransaction((tx) =>
      tx.delete(userPhoneMapping).where(and(eq(userPhoneMapping.tenantId, tenantId), eq(userPhoneMapping.userId, userId))),
    );
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true };
  });
}

export async function uploadDncList(text: string): Promise<ActionResult<{ added: number; invalid: number }>> {
  if (text.length > 2_000_000) return { ok: false, message: 'File too large (2 MB max).' };
  return session<{ added: number; invalid: number }>(async ({ tenantId, userId, role }) => {
    if (!isManager(role)) return { ok: false, message: 'Only managers and admins can edit the DNC list.' };
    const { numbers, invalid } = parseDncUpload(text);
    await tenantTransaction(async (tx) => {
      for (const n of numbers) await addDnc(tx, { tenantId, phone: n, reason: 'Uploaded list', addedBy: userId });
    });
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true, added: numbers.length, invalid };
  });
}

export async function removeDncNumber(phoneNormalized: string): Promise<ActionResult> {
  return session<object>(async ({ tenantId, role }) => {
    if (!isManager(role)) return { ok: false, message: 'Only managers and admins can edit the DNC list.' };
    await tenantTransaction((tx) =>
      tx.delete(dncNumbers).where(and(eq(dncNumbers.tenantId, tenantId), eq(dncNumbers.phoneNormalized, phoneNormalized))),
    );
    revalidatePath('/dashboard/settings/telephony');
    return { ok: true };
  });
}

/** Admin "test call": rings the admin's own mapped phone, then the given number. */
export async function placeTestCall(phone: string): Promise<ActionResult<{ callId: string }>> {
  return session<{ callId: string }>(async (v) => {
    if (!isAdmin(v.role)) return { ok: false, message: 'Only admins can place test calls.' };
    const hasAccount = await tenantTransaction((tx) => getActiveAccountRow(tx, v.tenantId));
    if (!hasAccount) return { ok: false, message: 'Save an active account first.' };
    const { callId } = await clickToCall({ ...v, phone, overrideHours: true });
    return { ok: true, callId };
  });
}

/* --------------------------------------------------------------- campaigns */

const CampaignInput = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['preview', 'progressive']),
  stages: z.array(z.string()).default([]),
  ownerIds: z.array(z.string()).default([]),
  leadSourceIds: z.array(z.string().uuid()).default([]),
  createdAfter: z.string().nullish(),
  agentIds: z.array(z.string()).min(1),
  callingHours: z.object({ tz: z.string(), start: z.string(), end: z.string() }),
  maxAttempts: z.number().int().min(1).max(20),
  retryGapMinutes: z.number().int().min(0).max(10080),
});

export async function createCallCampaign(input: z.infer<typeof CampaignInput>): Promise<ActionResult<{ id: string }>> {
  const parsed = CampaignInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid campaign.' };
  return session<{ id: string }>(async ({ tenantId, userId, role }) => {
    if (!isManager(role)) return { ok: false, message: 'Only managers can create campaigns.' };
    const d = parsed.data;
    const c = await createCampaign({
      tenantId,
      userId,
      input: {
        name: d.name,
        mode: d.mode,
        leadFilter: {
          stages: d.stages.length ? d.stages : undefined,
          ownerIds: d.ownerIds.length ? d.ownerIds : undefined,
          leadSourceIds: d.leadSourceIds.length ? d.leadSourceIds : undefined,
          createdAfter: d.createdAfter || undefined,
        },
        agentIds: d.agentIds,
        callingHours: d.callingHours,
        maxAttempts: d.maxAttempts,
        retryGapMinutes: d.retryGapMinutes,
      },
    });
    revalidatePath('/dashboard/telephony/campaigns');
    return { ok: true, id: c.id };
  });
}

export async function changeCampaignStatus(campaignId: string, status: 'running' | 'paused' | 'completed'): Promise<ActionResult> {
  return session<object>(async ({ tenantId, role }) => {
    if (!isManager(role)) return { ok: false, message: 'Only managers can start or pause campaigns.' };
    const c = await setCampaignStatus(tenantId, campaignId, status);
    if (!c) return { ok: false, message: 'Campaign not found.' };
    revalidatePath(`/dashboard/telephony/campaigns/${campaignId}`);
    return { ok: true };
  });
}

export type DialerLead = NonNullable<Awaited<ReturnType<typeof claimNextItem>>>;

export async function pullNextLead(campaignId: string): Promise<ActionResult<{ next: DialerLead | null }>> {
  return session<{ next: DialerLead | null }>(async ({ tenantId, userId }) => {
    const next = await claimNextItem({ tenantId, campaignId, agentUserId: userId });
    return { ok: true, next };
  });
}

export async function dialCampaignItem(itemId: string): Promise<ActionResult<{ callId: string }>> {
  return session<{ callId: string }>(async (v) => {
    const r = await dialClaimedItem({ ...v, itemId });
    return { ok: true, callId: r.callId };
  });
}

export async function skipCampaignItem(itemId: string, reason: string | null): Promise<ActionResult> {
  return session<object>(async ({ tenantId, userId }) => {
    await skipClaimedItem({ tenantId, userId, itemId, reason });
    return { ok: true };
  });
}
