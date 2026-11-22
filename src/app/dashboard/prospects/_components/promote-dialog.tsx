'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import type { PromoteChoice, PromoteOutcome, PromoteRouting } from '@/lib/prospects/promote/promote';
import type { MatchCandidate } from '@/lib/prospects/promote/rules';

import { promoteProspectAction } from '../actions';

type Props = {
  prospectId: string;
  /** Name of the active claimer, used in the routing line. */
  claimerName: string | null;
  /** Managers, owners and admins may skip the duplicate check. */
  canCreateAnyway: boolean;
  onClose: () => void;
};

type View =
  | { kind: 'checking' }
  | { kind: 'blocked' | 'warn'; candidates: MatchCandidate[] }
  | { kind: 'done'; dealId: string; linked: boolean; routing: PromoteRouting }
  | { kind: 'error'; message: string };

const REASONS: Record<MatchCandidate['reason'], string> = {
  name: 'Same company name',
  domain: 'Same domain',
  email: 'Same email',
  phone: 'Same phone',
  open_lead: 'Open lead for this company',
  fuzzy_name: 'Similar name',
};

const KIND_LABELS: Record<MatchCandidate['kind'], string> = {
  company: 'Company',
  contact: 'Contact',
  open_lead: 'Open lead',
};

const KINDS: MatchCandidate['kind'][] = ['company', 'contact', 'open_lead'];

const OPEN_LEAD_NOTE = "There's already an open lead for this company — link to it instead?";

const btn = 'rounded-md border border-slate-300 bg-white px-3 py-1 text-[13px] font-medium text-slate-700 disabled:opacity-50';
const primary = 'rounded-md bg-indigo-600 px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50';

function routingLine(routing: PromoteRouting, claimerName: string | null): string {
  switch (routing) {
    case 'claimer':
      return `Assigned to ${claimerName ?? 'the claimer'}`;
    case 'distributed':
      return 'Routed by your distribution rules';
    case 'unassigned':
    case 'queued':
      return 'Waiting in the unassigned queue';
    case 'retry':
      return 'Promoted — routing will retry';
    case 'none':
      return 'Linked to the existing lead';
  }
}

export function PromoteDialog({ prospectId, claimerName, canCreateAnyway, onClose }: Props) {
  const [view, setView] = useState<View>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pick, setPick] = useState<{ leadId: string; companyId: string; contactId: string }>({ leadId: '', companyId: '', contactId: '' });
  const started = useRef(false);

  function apply(r: Awaited<ReturnType<typeof promoteProspectAction>>, keep?: View) {
    setBusy(false);
    if (!r.ok || !r.data) {
      const message = r.ok ? 'Something went wrong. Try again.' : r.message;
      if (keep) setNotice(message);
      else setView({ kind: 'error', message });
      return;
    }
    const o: PromoteOutcome = r.data;
    if (o.status === 'promoted') setView({ kind: 'done', dealId: o.dealId, linked: o.linked, routing: o.routing });
    else if (o.status === 'blocked' || o.status === 'warn') {
      setNotice(null);
      setView({ kind: o.status, candidates: o.candidates });
    } else if (keep) setNotice(o.message);
    else setView({ kind: 'error', message: o.message });
  }

  useEffect(() => {
    // The ref keeps React strict-mode's double effect from promoting twice.
    if (started.current) return;
    started.current = true;
    void promoteProspectAction(prospectId).then((r) => apply(r));
  }, [prospectId]);

  function send(choice: PromoteChoice) {
    if (view.kind === 'checking') return;
    setBusy(true);
    setNotice(null);
    void promoteProspectAction(prospectId, choice).then((r) => apply(r, view));
  }

  const candidates = view.kind === 'blocked' || view.kind === 'warn' ? view.candidates : [];
  const byKind = (k: MatchCandidate['kind']) => candidates.filter((c) => c.kind === k);
  const strongKinds = new Set(candidates.filter((c) => c.strength === 'strong').map((c) => c.kind));

  // Mirrors the server: a lead pick stands alone; otherwise every strong kind needs a pick.
  const covered = pick.leadId
    ? true
    : (!strongKinds.has('company') || !!pick.companyId) &&
      (!strongKinds.has('contact') || !!pick.contactId);
  const anyPick = !!(pick.leadId || pick.companyId || pick.contactId);
  const canUse = anyPick && covered;

  function choose(kind: MatchCandidate['kind'], id: string) {
    setPick((p) =>
      kind === 'open_lead'
        ? { leadId: id, companyId: '', contactId: '' }
        : { ...p, leadId: '', [kind === 'company' ? 'companyId' : 'contactId']: id },
    );
  }

  function useThis() {
    send({
      leadId: pick.leadId || undefined,
      companyId: pick.companyId || undefined,
      contactId: pick.contactId || undefined,
      ignoreWarnings: view.kind === 'warn' ? true : undefined,
    });
  }

  return (
    <section role="region" aria-label="Promote to lead" className="mb-4 rounded-md border border-indigo-200 bg-indigo-50/40 p-3 text-[13px] text-slate-800">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-slate-600">Promote to lead</h3>
        <button type="button" onClick={onClose} className="text-[12px] text-slate-500 hover:text-slate-700">
          Close
        </button>
      </div>

      {view.kind === 'checking' ? (
        <p role="status" className="mt-2 text-slate-600">
          Checking for existing records…
        </p>
      ) : null}

      {view.kind === 'error' ? (
        <p role="alert" className="mt-2 text-red-700">
          {view.message}
        </p>
      ) : null}

      {view.kind === 'done' ? (
        <div role="status" className="mt-2 space-y-1">
          <p>
            Promoted.{' '}
            <Link href={`/dashboard/deals/${view.dealId}`} className="font-medium text-indigo-700 underline">
              Open lead →
            </Link>
          </p>
          <p className="text-slate-600">{routingLine(view.routing, claimerName)}</p>
        </div>
      ) : null}

      {view.kind === 'blocked' || view.kind === 'warn' ? (
        <div className="mt-2">
          <p className="text-slate-700">
            {view.kind === 'blocked'
              ? 'This looks like something already in your CRM. Pick what to link to.'
              : 'These records look similar. Pick one, or promote anyway.'}
          </p>
          {KINDS.filter((k) => byKind(k).length > 0).map((kind) => (
            <fieldset key={kind} className="mt-3">
              <legend className="mb-1 text-[12px] font-medium text-slate-600">{KIND_LABELS[kind]}</legend>
              <ul className="space-y-1">
                {byKind(kind).map((c) => {
                  const selected = kind === 'open_lead' ? pick.leadId === c.id : kind === 'company' ? pick.companyId === c.id : pick.contactId === c.id;
                  return (
                    <li key={`${c.kind}:${c.id}`}>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="radio"
                          name={`promote-${kind}`}
                          checked={selected}
                          disabled={busy}
                          onChange={() => choose(kind, c.id)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{c.label}</span>
                          {c.sublabel ? <span className="text-slate-500"> · {c.sublabel}</span> : null}
                          <span className="block text-[12px] text-slate-500">{REASONS[c.reason]}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {kind === 'open_lead' && !pick.leadId && (pick.companyId || pick.contactId) ? (
                <p className="mt-1 text-[12px] text-amber-700">{OPEN_LEAD_NOTE}</p>
              ) : null}
            </fieldset>
          ))}

          {strongKinds.size > 1 && !pick.leadId ? (
            <p className="mt-2 text-[12px] text-slate-500">Pick one for each group, or link the open lead.</p>
          ) : null}

          {notice ? (
            <p role="alert" className="mt-2 text-red-700">
              {notice}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy || !canUse} onClick={useThis} className={primary}>
              Use this
            </button>
            {view.kind === 'warn' ? (
              <button type="button" disabled={busy} onClick={() => send({ ignoreWarnings: true })} className={btn}>
                Promote anyway
              </button>
            ) : null}
            {canCreateAnyway ? (
              <button type="button" disabled={busy} onClick={() => send({ createAnyway: true })} className={btn}>
                Create anyway
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
