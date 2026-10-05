'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { validatePlanTerms } from '@/lib/incentives/engine';
import type { PlanStatus } from '@/lib/incentives/rollup';
import { diffTerms, termLabel, type StoredTerms, type TermKey } from '@/lib/incentives/terms';
import type { ActualsSource, ActualsView } from '@/lib/incentives/types';

import { IncentiveCalculator, Panel } from '../../../incentives/_components/incentive-calculator';
import { createPlanAction, updatePlanAction } from '../../../incentives/actions';
import { TermsForm, inputClass } from './terms-form';

type Common = {
  displayName: string;
  fiscalLabel: string;
  actuals: ActualsView | null;
};

type CreateProps = Common & {
  mode: 'create';
  userId: string;
  fiscalYear: number;
  /** Pre-filled from the tenant template. */
  initialTerms: StoredTerms;
};

type EditProps = Common & {
  mode: 'edit';
  planId: string;
  version: number;
  status: PlanStatus;
  actualsSource: ActualsSource;
  initialTerms: StoredTerms;
  /** The template, to show which fields this plan overrides. */
  templateTerms: StoredTerms;
};

/**
 * Create or edit one resource's plan, with the SPOC's calculator rendered
 * live underneath as a preview: what the admin sees while typing is what
 * the resource will see once the plan is active.
 *
 * Edits carry the version the page loaded; if someone else saved in
 * between, the server refuses and the admin reloads rather than
 * overwriting.
 */
export function PlanEditor(props: CreateProps | EditProps) {
  const router = useRouter();
  const [terms, setTerms] = useState<StoredTerms>(props.initialTerms);
  const [note, setNote] = useState('');
  const [createStatus, setCreateStatus] = useState<PlanStatus>('draft');
  const [pending, start] = useTransition();
  const issues = validatePlanTerms(terms);
  const changed = props.mode === 'edit' ? diffTerms(props.initialTerms, terms) : {};
  const overrides = props.mode === 'edit' ? Object.keys(diffTerms(props.templateTerms, terms)) : [];

  function done(res: { ok: true } | { ok: false; message: string; conflict?: boolean }, okMsg: string) {
    if (res.ok) {
      toast.success(okMsg);
      setNote('');
      router.refresh();
    } else {
      toast.error(res.message, { duration: res.conflict ? 10_000 : 5_000 });
    }
  }

  function saveTerms() {
    start(async () => {
      if (props.mode === 'create') {
        const res = await createPlanAction({ userId: props.userId, fiscalYear: props.fiscalYear, terms, status: createStatus });
        if (res.ok) {
          toast.success(`Plan created for ${props.displayName}`);
          router.replace(`/dashboard/settings/incentives/plan?planId=${res.value.planId}`);
        } else {
          toast.error(res.message);
        }
        return;
      }
      done(await updatePlanAction({ planId: props.planId, expectedVersion: props.version, terms, note: note || null }), 'Plan saved as a new version');
    });
  }

  function setStatus(status: PlanStatus) {
    if (props.mode !== 'edit') return;
    start(async () => {
      done(await updatePlanAction({ planId: props.planId, expectedVersion: props.version, status, note: note || null }), `Plan ${status === 'active' ? 'activated' : status === 'closed' ? 'closed' : 'moved to draft'}`);
    });
  }

  function setSource(actualsSource: ActualsSource) {
    if (props.mode !== 'edit') return;
    const msg =
      actualsSource === 'computed'
        ? 'Switch to COMPUTED actuals? The calculator will read figures calculated nightly from won deals, and manual entries stop being used.'
        : 'Switch to MANUAL actuals? The calculator will read entered figures, and the nightly job stops updating this plan.';
    if (!window.confirm(msg)) return;
    start(async () => {
      done(await updatePlanAction({ planId: props.planId, expectedVersion: props.version, actualsSource, note: note || null }), 'Actuals source switched');
    });
  }

  const dirtyCount = Object.keys(changed).length;

  return (
    <div className="space-y-4">
      <Panel
        title={props.mode === 'create' ? `New plan · ${props.displayName} · ${props.fiscalLabel}` : `${props.displayName} · ${props.fiscalLabel}`}
        aside={
          props.mode === 'edit' ? (
            <span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
              v{props.version} · <strong className="uppercase">{props.status}</strong> · actuals {props.actualsSource}
            </span>
          ) : (
            <span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">pre-filled from the workspace template</span>
          )
        }
      >
        <TermsForm value={terms} onChange={setTerms} disabled={pending} />

        {issues.length > 0 ? (
          <ul className="mt-3 list-disc pl-5 text-[12px] text-rose-600 dark:text-rose-400">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        ) : null}

        {props.mode === 'edit' && overrides.length > 0 ? (
          <p className="mt-3 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
            Overrides the template on: {overrides.map((k) => termLabel(k as TermKey)).join(', ')}.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3 dark:border-[#1F1F1F]">
          {props.mode === 'create' ? (
            <label className="block">
              <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Start as</span>
              <select value={createStatus} onChange={(e) => setCreateStatus(e.target.value as PlanStatus)} className={`${inputClass} mt-1 w-40`}>
                <option value="draft">Draft (hidden from resource)</option>
                <option value="active">Active</option>
              </select>
            </label>
          ) : (
            <label className="block min-w-[16rem] flex-1">
              <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">Change note (optional, kept in the audit trail)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={`${inputClass} mt-1`} placeholder="e.g. FY26 mid-year slab revision" />
            </label>
          )}
          <button
            type="button"
            onClick={saveTerms}
            disabled={pending || issues.length > 0 || (props.mode === 'edit' && dirtyCount === 0)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {props.mode === 'create' ? 'Create plan' : dirtyCount > 0 ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'} as v${props.version + 1}` : 'No changes'}
          </button>
          {props.mode === 'edit' ? (
            <div className="ml-auto flex flex-wrap gap-2">
              {props.status !== 'active' ? (
                <SecondaryButton disabled={pending || dirtyCount > 0} onClick={() => setStatus('active')}>
                  Activate
                </SecondaryButton>
              ) : null}
              {props.status === 'active' ? (
                <SecondaryButton disabled={pending || dirtyCount > 0} onClick={() => setStatus('closed')}>
                  Close plan
                </SecondaryButton>
              ) : null}
              {props.status !== 'draft' ? (
                <SecondaryButton disabled={pending || dirtyCount > 0} onClick={() => setStatus('draft')}>
                  Back to draft
                </SecondaryButton>
              ) : null}
              <SecondaryButton
                disabled={pending || dirtyCount > 0}
                onClick={() => setSource(props.actualsSource === 'manual' ? 'computed' : 'manual')}
              >
                Use {props.actualsSource === 'manual' ? 'computed' : 'manual'} actuals
              </SecondaryButton>
            </div>
          ) : null}
        </div>
        {props.mode === 'edit' && dirtyCount > 0 ? (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Save or discard your term changes before changing status or actuals source.</p>
        ) : null}
      </Panel>

      <div>
        <h2 className="mb-2 text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">
          Preview — what {props.displayName} will see
        </h2>
        <IncentiveCalculator
          terms={terms}
          actuals={props.actuals}
          actualsSource={props.mode === 'edit' ? props.actualsSource : 'manual'}
          fiscalLabel={props.fiscalLabel}
          planId={null}
          canEditActuals={false}
          subject="other"
        />
      </div>
    </div>
  );
}

function SecondaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-[#1F1F1F] dark:text-[#D4D4D8] dark:hover:bg-[#181818]"
    >
      {children}
    </button>
  );
}
