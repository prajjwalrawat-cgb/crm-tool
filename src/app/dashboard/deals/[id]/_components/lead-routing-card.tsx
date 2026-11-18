import { runWithTenantContext } from '@/lib/db-context';
import { getAssignmentHistory, getDealCaptureInfo } from '@/lib/lead-capture/admin';

import { LeadReassignControl } from './lead-reassign-control';

const fmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const when = (d: Date | null) => (d ? fmt.format(d) : '—');

function byLabel(assignedBy: string, ruleName: string | null, nameOf: (id: string) => string): string {
  if (assignedBy.startsWith('rule:')) return ruleName ? `rule “${ruleName}”` : 'a distribution rule';
  if (assignedBy === 'system:sla') return 'SLA reassignment';
  if (assignedBy === 'system:retry') return 'queue retry';
  if (assignedBy.startsWith('user:')) return nameOf(assignedBy.slice(5));
  return assignedBy;
}

/**
 * Lead capture on the deal page (0072): where the lead came from and its
 * assignment history (who had it, by which rule, first touch vs SLA, and why
 * it moved). Renders nothing for deals that were never routed.
 * Async server component — loads its own data so the page batch is untouched.
 * React renders it after the page's withTenantSession callback has returned,
 * so it must enter the tenant context itself.
 */
export async function LeadRoutingCard({
  tenantId,
  userId,
  dealId,
  teammates,
  canAssign,
}: {
  tenantId: string;
  userId: string;
  dealId: string;
  teammates: Array<{ id: string; displayName: string }>;
  canAssign: boolean;
}) {
  const [info, history] = await runWithTenantContext({ tenantId, userId }, () =>
    Promise.all([getDealCaptureInfo(tenantId, dealId), getAssignmentHistory(tenantId, dealId)]),
  );
  if (!info || (!info.sourceName && history.length === 0 && !info.routingStatus)) return null;
  const nameOf = (id: string) => teammates.find((t) => t.id === id)?.displayName ?? 'Unknown user';
  const utm = [info.utmSource, info.utmMedium, info.utmCampaign].filter(Boolean).join(' / ');

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-[#262626] dark:bg-[#0F0F0F]">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">Lead routing</div>
        {info.routingStatus === 'unassigned' ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">In unassigned queue</span>
        ) : null}
      </div>
      <dl className="mt-1.5 space-y-0.5 text-[12px]">
        {info.sourceName ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-slate-500">Source</dt>
            <dd className="text-slate-800 dark:text-[#E4E4E7]">{info.sourceName}</dd>
          </div>
        ) : null}
        {utm ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-slate-500">Campaign</dt>
            <dd className="text-slate-800 dark:text-[#E4E4E7]">{utm}</dd>
          </div>
        ) : null}
        {info.consentGiven !== null ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-slate-500">Consent</dt>
            <dd className="text-slate-800 dark:text-[#E4E4E7]">{info.consentGiven ? 'Given' : 'Not given'}</dd>
          </div>
        ) : null}
        {info.lastEnquiryAt ? (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-slate-500">Last enquiry</dt>
            <dd className="text-slate-800 dark:text-[#E4E4E7]">{when(info.lastEnquiryAt)}</dd>
          </div>
        ) : null}
      </dl>

      {history.length ? (
        <ol className="mt-2.5 space-y-2 border-l border-slate-200 pl-3 dark:border-[#262626]" aria-label="Assignment history">
          {history.map((a) => {
            const open = !a.releasedAt;
            const late = !a.firstTouchAt && a.slaPassed;
            return (
              <li key={a.id} className="text-[12px]">
                <div className="font-medium text-slate-900 dark:text-[#FAFAFA]">
                  {nameOf(a.assignedTo)} <span className="font-normal text-slate-500">via {byLabel(a.assignedBy, a.ruleName, nameOf)}</span>
                </div>
                <div className="text-slate-600 dark:text-[#A1A1AA]">
                  {when(a.assignedAt)} ·{' '}
                  {a.firstTouchAt ? (
                    <span>first touch {when(a.firstTouchAt)}{a.firstTouchAt <= a.slaDueAt ? ' (within SLA)' : ' (after SLA)'}</span>
                  ) : open ? (
                    <span className={late ? 'font-medium text-rose-700 dark:text-rose-300' : undefined}>
                      {late ? 'SLA missed' : 'respond by'} {when(a.slaDueAt)}
                    </span>
                  ) : (
                    <span>no response</span>
                  )}
                </div>
                {a.releasedAt ? (
                  <div className="text-slate-500">
                    Released {when(a.releasedAt)} — {a.releaseReason === 'sla_breach' ? 'SLA missed' : a.releaseReason === 'manual_reassign' ? 'reassigned by a manager' : a.releaseReason}
                  </div>
                ) : null}
                {a.escalatedAt ? <div className="text-rose-700 dark:text-rose-300">Escalated to managers {when(a.escalatedAt)}</div> : null}
                {a.reason && a.assignedBy.startsWith('user:') ? <div className="text-slate-500">“{a.reason}”</div> : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {canAssign ? <LeadReassignControl dealId={dealId} people={teammates.map((t) => ({ id: t.id, name: t.displayName }))} /> : null}
    </div>
  );
}
