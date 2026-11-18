import 'server-only';

import { and, eq } from 'drizzle-orm';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';

import { contacts, deals } from '@/db/schema';
import { runWithSystemContext, runWithTenantContext, tenantTransaction } from '@/lib/db-context';
import { requireMembership } from '@/lib/membership';
import { normalizePhone } from '@/lib/lead-capture/normalize';
import { getActiveAccountRow, isDnc } from '@/lib/telephony/accounts';
import { DISPOSITION_LABELS, formatDuration, serializeCall } from '@/lib/telephony/serialize';
import { listCallsScoped } from '@/lib/telephony/service';

import { CallRecordingPlayer } from './call-recording-player';
import { CallSummaryCard } from './call-summary-card';
import { ClickToCallButton } from './click-to-call-button';

/**
 * Deal-page telephony. Both are async server components that load their own
 * data, so the deal page only has to place them. They render nothing when
 * telephony isn't set up for the workspace.
 */

async function loadDealPhone(tenantId: string, dealId: string) {
  // Rendered after the page's tenant session returns: enter the context here.
  return await runWithSystemContext(tenantId, () => tenantTransaction(async (tx) => {
    const account = await getActiveAccountRow(tx, tenantId);
    if (!account) return null;
    const [row] = await tx
      .select({ phone: contacts.phone, phoneNorm: contacts.phoneNormalized, contactId: contacts.id })
      .from(deals)
      .leftJoin(contacts, eq(contacts.id, deals.contactId))
      .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)));
    const norm = row?.phoneNorm ?? normalizePhone(row?.phone ?? null);
    return { phone: row?.phone ?? null, dnc: await isDnc(tx, tenantId, norm), hasPhone: !!norm };
  }));
}

export async function DealCallButton({ tenantId, dealId }: { tenantId: string; dealId: string }) {
  const info = await loadDealPhone(tenantId, dealId);
  if (!info) return null;
  return (
    <ClickToCallButton
      leadId={dealId}
      dnc={info.dnc}
      disabledReason={info.hasPhone ? null : 'The contact has no phone number'}
      label={info.phone ? `Call ${info.phone}` : 'Call'}
    />
  );
}

const STATUS_TONE: Record<string, string> = {
  completed: 'text-emerald-700 dark:text-emerald-300',
  answered: 'text-emerald-700 dark:text-emerald-300',
  missed: 'text-rose-700 dark:text-rose-300',
  no_answer: 'text-amber-700 dark:text-amber-300',
  busy: 'text-amber-700 dark:text-amber-300',
  failed: 'text-rose-700 dark:text-rose-300',
};

export async function DealCallsCard({ tenantId, userId, dealId }: { tenantId: string; userId: string; dealId: string }) {
  const membership = await requireMembership();
  const rows = await runWithTenantContext({ tenantId, userId }, () =>
    listCallsScoped({ tenantId, viewer: { userId, role: membership.role }, leadId: dealId, limit: 50 }),
  );
  if (rows.length === 0) return null;
  const items = rows.map((r) => serializeCall(r, { includeTranscript: true }));
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <h2 className="mb-3 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">Calls</h2>
      <ol className="space-y-3">
        {items.map((c) => {
          const Icon = c.direction === 'outbound' ? PhoneOutgoing : PhoneIncoming;
          const when = new Date(c.startedAt ?? c.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
          return (
            <li key={c.id} id={`call-${c.id}`} className="scroll-mt-20 border-b border-slate-100 pb-3 last:border-0 last:pb-0 dark:border-[#181818]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                <span className="font-medium text-slate-800 dark:text-[#E4E4E7]">{c.direction === 'outbound' ? `To ${c.toNumber}` : `From ${c.fromNumber}`}</span>
                <span className={STATUS_TONE[c.status] ?? 'text-slate-500'}>{c.status.replace('_', ' ')}</span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-500">{formatDuration(c.talkTimeSec ?? c.durationSec)}</span>
                {c.disposition ? (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-[#181818] dark:text-[#A1A1AA]">
                    {DISPOSITION_LABELS[c.disposition]}
                  </span>
                ) : null}
                <span className="ml-auto text-[11px] text-slate-400">{when}</span>
              </div>
              {c.notes ? <p className="mt-1 text-[12px] text-slate-600 dark:text-[#A1A1AA]">{c.notes}</p> : null}
              {c.hasRecording ? (
                <div className="mt-2">
                  <CallRecordingPlayer callId={c.id} durationSec={c.durationSec} />
                </div>
              ) : null}
              <CallSummaryCard
                callId={c.id}
                summary={c.aiSummary}
                transcript={c.transcript}
                segments={c.transcriptSegments}
                transcriptStatus={c.transcriptStatus}
                transcriptError={c.transcriptError}
                hasRecording={c.hasRecording}
                followUpTaskId={c.followUpTaskId}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
