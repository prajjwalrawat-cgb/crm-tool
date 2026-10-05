'use client';

import { AlertTriangle, CheckCircle2, Loader2, TrendingUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { computedActualsNotes } from '@/lib/incentives/disclosures';
import {
  buildLadder,
  calculateIncentive,
  marginStatus,
  nextStepFor,
  validateActuals,
  validatePlanTerms,
  whatItTakes,
  withExtraNetNew,
  type IncentiveActuals,
  type SlabZone,
} from '@/lib/incentives/engine';
import {
  fmtCr,
  fmtDeltaL,
  fmtL,
  fmtPct,
  fractionToPercent,
  percentToFraction,
  todayISO,
} from '@/lib/incentives/format';
import { canonicalDecimal, type StoredTerms } from '@/lib/incentives/terms';
import type { ActualsSource, ActualsView } from '@/lib/incentives/types';
import { cn } from '@/lib/utils';

import { recordManualActualsAction } from '../actions';

/**
 * The incentive calculator. ONE component for the SPOC's own page, a
 * manager's drill-down and the admin's pre-activation preview, so the admin
 * previews exactly what the SPOC will see.
 *
 * Every figure below is a field of an engine result (`calculateIncentive`,
 * `whatItTakes`, `nextStepFor`, `buildLadder`, `marginStatus`). This file
 * builds inputs and formats outputs; it does not multiply a rate.
 */

const ZONE_LABEL: Record<SlabZone, string> = {
  below_gate: 'Below the gate',
  slab1: 'Slab 1',
  slab2: 'Slab 2',
};

type Draft = { prior: string; netNew: string; marginPct: string };

function draftFrom(a: ActualsView | null): Draft {
  return {
    prior: canonicalDecimal(a?.priorYearRevenueCr) ?? '0',
    netNew: canonicalDecimal(a?.netNewRevenueCr) ?? '0',
    marginPct: a ? fractionToPercent(a.blendedMarginPct) : '0',
  };
}

function draftToActuals(d: Draft): IncentiveActuals {
  return {
    priorYearRevenueCr: d.prior.trim(),
    netNewRevenueCr: d.netNew.trim(),
    blendedMarginPct: percentToFraction(d.marginPct),
  };
}

export type IncentiveCalculatorProps = {
  terms: StoredTerms;
  actuals: ActualsView | null;
  actualsSource: ActualsSource;
  fiscalLabel: string;
  /** Null in the admin preview of an unsaved plan. */
  planId: string | null;
  canEditActuals: boolean;
  /** Resolved display name for `actuals.enteredBy`. */
  enteredByName?: string | null;
  /** Shown as "You" vs a name in copy. */
  subject: 'self' | 'other';
  planClosed?: boolean;
};

export function IncentiveCalculator(props: IncentiveCalculatorProps) {
  const { terms, actuals, actualsSource, canEditActuals, planId } = props;
  const router = useRouter();
  const manual = actualsSource === 'manual';
  const editable = manual && canEditActuals && planId !== null && !props.planClosed;

  const [draft, setDraft] = useState<Draft>(() => draftFrom(actuals));
  const [extraCr, setExtraCr] = useState(0);
  const [saving, startSaving] = useTransition();

  const termIssues = useMemo(() => validatePlanTerms(terms), [terms]);
  const draftActuals = draftToActuals(draft);
  const actualIssues = validateActuals(draftActuals);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(actuals));

  const view = useMemo(() => {
    if (termIssues.length > 0 || actualIssues.length > 0) return null;
    const result = calculateIncentive(terms, draftActuals);
    const hypoActuals = withExtraNetNew(draftActuals, extraCr);
    const ladder = buildLadder(terms, { currentCreditedCr: result.creditedRevenue });
    return {
      result,
      wit: whatItTakes(terms, draftActuals),
      margin: marginStatus(terms, draftActuals),
      next: nextStepFor(terms, draftActuals),
      ladder,
      hypo: calculateIncentive(terms, hypoActuals),
      hypoNext: nextStepFor(terms, hypoActuals),
    };
    // draftActuals is derived from draft; keyed on the strings it came from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terms, draft.prior, draft.netNew, draft.marginPct, extraCr, termIssues.length, actualIssues.length]);

  if (termIssues.length > 0) {
    return (
      <Panel title="Plan can’t be calculated yet">
        <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-amber-700 dark:text-amber-300">
          {termIssues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </Panel>
    );
  }

  function save() {
    if (!planId) return;
    startSaving(async () => {
      const res = await recordManualActualsAction({
        planId,
        asOfDate: todayISO(),
        priorYearRevenueCr: draftActuals.priorYearRevenueCr,
        netNewRevenueCr: draftActuals.netNewRevenueCr,
        blendedMarginPct: draftActuals.blendedMarginPct,
      });
      if (res.ok) {
        toast.success('Actuals saved');
        router.refresh();
      } else {
        toast.error(res.message);
      }
    });
  }

  const you = props.subject === 'self';
  const notes = actualsSource === 'computed' ? computedActualsNotes(actuals?.details) : [];
  // Slider ceiling: far enough to walk past the top of the ladder.
  const ladderTop = view?.ladder.at(-1)?.creditedRevenueCr ?? 0;
  const netNewWeight = Number(terms.netNewCreditPct) || 1;
  const sliderMax = view
    ? Math.max(5, Math.ceil(Math.max(0, ladderTop - view.result.creditedRevenue) / netNewWeight) + 2)
    : 10;

  return (
    <div className="space-y-4">
      {/* ---------------- Actuals ---------------- */}
      <Panel
        title="Actuals"
        aside={
          <SourceBadge
            source={actualsSource}
            actuals={actuals}
            enteredByName={props.enteredByName}
          />
        }
      >
        {!actuals ? (
          <p className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:bg-[#161616] dark:text-[#A1A1AA]">
            {actualsSource === 'computed'
              ? 'No computed actuals yet — they are calculated nightly from won deals. Figures below assume ₹0 revenue.'
              : 'No actuals recorded yet. Figures below assume ₹0 revenue until they are entered.'}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <ActualInput
            label="Prior-year revenue"
            hint="Recognised this FY from deals closed in an earlier FY"
            unit="₹ Cr"
            value={draft.prior}
            readOnly={!editable}
            onChange={(v) => setDraft((d) => ({ ...d, prior: v }))}
          />
          <ActualInput
            label="Net-new revenue"
            hint="Recognised this FY from deals closed this FY"
            unit="₹ Cr"
            value={draft.netNew}
            readOnly={!editable}
            onChange={(v) => setDraft((d) => ({ ...d, netNew: v }))}
          />
          <ActualInput
            label="Blended margin"
            hint="Revenue-weighted, across the revenue base"
            unit="%"
            value={draft.marginPct}
            readOnly={!editable}
            onChange={(v) => setDraft((d) => ({ ...d, marginPct: v }))}
          />
        </div>
        {actualIssues.length > 0 ? (
          <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{actualIssues.join(' · ')}</p>
        ) : null}
        {editable ? (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving || actualIssues.length > 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Save as today’s actuals
            </button>
            {dirty ? (
              <span className="text-[12px] text-amber-700 dark:text-amber-300">
                Unsaved — the figures below already reflect what you typed.
              </span>
            ) : null}
          </div>
        ) : null}
        {notes.length > 0 ? (
          <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-[12px] text-slate-500 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
            {notes.map((n) => (
              <li key={n}>• {n}</li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {view ? (
        <>
          {/* ---------------- Current projection ---------------- */}
          <Panel title={`Current projection · ${props.fiscalLabel}`}>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
              <Tile
                label="Credited revenue"
                value={fmtCr(view.result.creditedRevenue)}
                sub={`${fmtCr(view.result.priorYearCredited)} prior-year + ${fmtCr(view.result.netNewCredited)} net-new`}
              />
              <Tile
                label="Gate"
                value={view.result.gateMet ? 'Crossed' : 'Not yet'}
                sub={
                  view.result.gateMet
                    ? `Gate is ${fmtCr(Number(terms.gateRevenueCr))}`
                    : `${fmtCr(view.result.gateShortfallCr)} credited to go`
                }
                tone={view.result.gateMet ? 'good' : 'warn'}
              />
              <Tile
                label="Projected payout"
                value={fmtL(view.result.finalPayoutL)}
                sub="at current pace"
                tone="accent"
              />
              <Tile
                label="% of target variable"
                value={fmtPct(view.result.payoutPctOfTarget)}
                sub={`target ${fmtL(Number(terms.targetVariable))}`}
                tone={view.result.payoutPctOfTarget > 1 ? 'good' : undefined}
              />
              <Tile
                label="Total cash comp"
                value={fmtL(view.result.totalCashCompL)}
                sub={`${fmtL(Number(terms.fixedCTC))} fixed + ${fmtL(view.result.finalPayoutL)} variable`}
              />
            </div>
            <p className="mt-3 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
              Gate {fmtL(view.result.gateIncentive)} + slab 1 {fmtL(view.result.slab1Incentive)} + slab 2{' '}
              {fmtL(view.result.slab2Incentive)} = gross {fmtL(view.result.grossIncentive)}
              {view.result.capApplied ? ` → capped at ${fmtL(view.result.afterCap)}` : ''}
              {view.result.marginMultiplier !== 1
                ? ` → × ${fmtPct(view.result.marginMultiplier)} margin = ${fmtL(view.result.finalPayoutL)}`
                : ''}
            </p>
          </Panel>

          {/* ---------------- Margin callout ---------------- */}
          <MarginCallout
            floor={Number(terms.marginFloorPct)}
            actual={Number(draftActuals.blendedMarginPct)}
            status={view.margin}
            beforeMarginL={view.result.afterCap}
            afterMarginL={view.result.finalPayoutL}
          />

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ---------------- What it takes ---------------- */}
            <Panel title="What it takes for 100%">
              <WhatItTakesBody wit={view.wit} terms={terms} you={you} />
            </Panel>

            {/* ---------------- Overshoot ---------------- */}
            <Panel title="If I overshoot">
              <label className="block text-[12px] text-slate-600 dark:text-[#A1A1AA]">
                Extra net-new revenue: <strong className="text-slate-900 dark:text-[#FAFAFA]">{fmtCr(extraCr)}</strong>
              </label>
              <input
                type="range"
                min={0}
                max={sliderMax}
                step={0.1}
                value={extraCr}
                onChange={(e) => setExtraCr(Number(e.target.value))}
                className="mt-1 w-full accent-indigo-600"
                aria-label="Extra net-new revenue in crore"
              />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Tile label="Credited" value={fmtCr(view.hypo.creditedRevenue)} />
                <Tile label="Payout" value={fmtL(view.hypo.finalPayoutL)} tone="accent" />
                <Tile
                  label="vs today"
                  value={fmtDeltaL(view.hypo.finalPayoutL - view.result.finalPayoutL)}
                  sub={fmtPct(view.hypo.payoutPctOfTarget) + ' of target'}
                  tone={view.hypo.payoutPctOfTarget > 1 ? 'good' : undefined}
                />
              </div>
              <div className="mt-3 rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[12px] text-indigo-900 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-200">
                <TrendingUp className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                The next {fmtCr(Number(terms.stepCr))} of credited revenue{extraCr > 0 ? ' from there' : ''} falls in{' '}
                <strong>{ZONE_LABEL[view.hypoNext.zone]}</strong> and adds{' '}
                <strong>{fmtL(view.hypoNext.incrementalPayoutL)}</strong>
                {view.hypoNext.cappedOut ? ' — the payout cap is absorbing it' : ''}.
              </div>
              <p className="mt-2 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
                Rates per {fmtCr(Number(terms.stepCr))} credited: slab 1 {fmtL(Number(terms.slab1RateL))} up to{' '}
                {fmtCr(Number(terms.slab1UpperCr))}, slab 2 {fmtL(Number(terms.slab2RateL))} beyond.
                {terms.accrualBasis === 'full_step_only' ? ' Only completed steps pay.' : ' Part-steps pay pro rata.'}
                {terms.capEnabled ? ` Capped at ${fmtL(Number(terms.capAmountL))}.` : ''}
              </p>
            </Panel>
          </div>

          {/* ---------------- Ladder ---------------- */}
          <Panel title="Ladder" aside={<span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">margin floor assumed met</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] tabular-nums">
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#A1A1AA]">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Credited revenue</th>
                    <th className="px-2 py-1.5 font-medium">Slab</th>
                    <th className="px-2 py-1.5 text-right font-medium">Gate</th>
                    <th className="px-2 py-1.5 text-right font-medium">Slab 1</th>
                    <th className="px-2 py-1.5 text-right font-medium">Slab 2</th>
                    <th className="px-2 py-1.5 text-right font-medium">Payout</th>
                    <th className="px-2 py-1.5 text-right font-medium">% target</th>
                  </tr>
                </thead>
                <tbody>
                  {view.ladder.map((r) => (
                    <tr
                      key={r.creditedRevenueCr}
                      aria-current={r.isCurrent ? 'true' : undefined}
                      className={cn(
                        'border-t border-slate-100 dark:border-[#1F1F1F]',
                        r.isCurrent && 'bg-indigo-50 font-semibold text-indigo-900 dark:bg-indigo-500/15 dark:text-indigo-100',
                      )}
                    >
                      <td className="px-2 py-1.5">
                        {fmtCr(r.creditedRevenueCr)}
                        {r.isCurrent ? <span className="ml-2 text-[10px] uppercase">← {you ? 'you' : 'now'}</span> : null}
                      </td>
                      <td className="px-2 py-1.5">{ZONE_LABEL[r.zone]}</td>
                      <td className="px-2 py-1.5 text-right">{fmtL(r.gateIncentive)}</td>
                      <td className="px-2 py-1.5 text-right">{fmtL(r.slab1Incentive)}</td>
                      <td className="px-2 py-1.5 text-right">{fmtL(r.slab2Incentive)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {fmtL(r.finalPayoutL)}
                        {r.afterCap < r.grossIncentive ? <span className="ml-1 text-[10px] text-amber-600">capped</span> : null}
                      </td>
                      <td className="px-2 py-1.5 text-right">{fmtPct(r.payoutPctOfTarget, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!view.ladder.some((r) => r.isCurrent) ? (
              <p className="mt-2 text-[12px] text-slate-500 dark:text-[#A1A1AA]">
                Current credited revenue ({fmtCr(view.result.creditedRevenue)}) is below the gate — no row applies yet.
              </p>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function WhatItTakesBody({
  wit,
  terms,
  you,
}: {
  wit: ReturnType<typeof whatItTakes>;
  terms: StoredTerms;
  you: boolean;
}) {
  if (!wit.needed.reachable) {
    return (
      <p className="text-[13px] text-amber-700 dark:text-amber-300">
        {wit.needed.reason === 'cap_below_target'
          ? `Full target payout isn’t reachable on this plan: the cap (${fmtL(Number(terms.capAmountL))}) is below the target variable (${fmtL(Number(terms.targetVariable))}).`
          : 'Full target payout isn’t reachable on this plan: the slab that would have to carry the rest pays ₹0 per step.'}
      </p>
    );
  }
  const needed = wit.needed.creditedRevenueCr;
  return (
    <div className="space-y-2 text-[13px] text-slate-700 dark:text-[#D4D4D8]">
      <p>
        Full target payout ({fmtL(Number(terms.targetVariable))}) needs{' '}
        <strong className="text-slate-900 dark:text-[#FAFAFA]">{fmtCr(needed)} credited revenue</strong>.
      </p>
      {wit.alreadyThere ? (
        <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {you ? 'You’re' : 'Already'} at {fmtCr(wit.currentCreditedCr)} — target reached. Everything above it is over-achievement.
        </p>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-[12px]">
          <li>
            Credited today: {fmtCr(wit.currentCreditedCr)}
          </li>
          <li>
            Gap: {fmtCr(needed)} − {fmtCr(wit.currentCreditedCr)} = <strong>{fmtCr(wit.creditedGapCr)}</strong> credited
          </li>
          <li>
            Prior-year revenue is already contracted, so only net-new moves. Net-new is credited at{' '}
            {fmtPct(wit.netNewCreditPct, 0)}:{' '}
            {wit.netNewRevenueNeededCr != null ? (
              <>
                {fmtCr(wit.creditedGapCr)} ÷ {fmtPct(wit.netNewCreditPct, 0)} ={' '}
                <strong className="text-slate-900 dark:text-[#FAFAFA]">{fmtCr(wit.netNewRevenueNeededCr)} more net-new</strong>{' '}
                ({fmtCr(wit.netNewRevenueTotalCr)} net-new in total)
              </>
            ) : (
              <strong>net-new earns no credit on this plan, so the gap can’t be closed with new deals.</strong>
            )}
          </li>
        </ol>
      )}
    </div>
  );
}

function MarginCallout({
  floor,
  actual,
  status,
  beforeMarginL,
  afterMarginL,
}: {
  floor: number;
  actual: number;
  status: ReturnType<typeof marginStatus>;
  beforeMarginL: number;
  afterMarginL: number;
}) {
  const head = `Margin floor is ${fmtPct(floor)}; current blended margin is ${fmtPct(actual)}`;
  let tail: string;
  let tone: 'good' | 'warn' | 'bad' | 'neutral';
  switch (status.kind) {
    case 'met':
      tail = '— floor met, no reduction.';
      tone = 'good';
      break;
    case 'not_enforced':
      tail = actual < floor ? '— below the floor, but margin is not enforced on this plan.' : '— margin is not enforced on this plan.';
      tone = 'neutral';
      break;
    case 'reduced':
      tail = `— payout reduced to ${fmtPct(status.payoutPctOfGross)} of gross.`;
      tone = 'warn';
      break;
    case 'nil':
      tail = '— payout is nil below the floor.';
      tone = 'bad';
      break;
  }
  const impacted = status.kind === 'reduced' || status.kind === 'nil';
  return (
    <div
      role={impacted ? 'alert' : undefined}
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-[13px]',
        tone === 'good' && 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200',
        tone === 'neutral' && 'border-slate-200 bg-slate-50 text-slate-700 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#D4D4D8]',
        tone === 'warn' && 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200',
        tone === 'bad' && 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200',
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        {impacted ? <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />}
        {head} {tail}
      </span>
      {impacted ? (
        <span className="tabular-nums">
          Before margin <strong>{fmtL(beforeMarginL)}</strong> → after margin <strong>{fmtL(afterMarginL)}</strong>{' '}
          ({fmtDeltaL(afterMarginL - beforeMarginL)})
        </span>
      ) : null}
    </div>
  );
}

function SourceBadge({
  source,
  actuals,
  enteredByName,
}: {
  source: ActualsSource;
  actuals: ActualsView | null;
  enteredByName?: string | null;
}) {
  const when = actuals?.computedAt ?? actuals?.createdAt;
  const stamp = when ? new Date(when).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  return (
    <span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
      <span
        className={cn(
          'mr-1.5 rounded px-1.5 py-0.5 font-medium uppercase tracking-wide',
          source === 'computed'
            ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'
            : 'bg-slate-100 text-slate-600 dark:bg-[#1F1F1F] dark:text-[#D4D4D8]',
        )}
      >
        {source === 'computed' ? 'Computed from deals' : 'Manual'}
      </span>
      {actuals ? (
        <>
          as of {actuals.asOfDate}
          {source === 'computed' && stamp ? ` · last synced ${stamp}` : ''}
          {source === 'manual' && enteredByName ? ` · entered by ${enteredByName}` : ''}
        </>
      ) : null}
    </span>
  );
}

function ActualInput({
  label,
  hint,
  unit,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  readOnly: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-slate-700 dark:text-[#D4D4D8]">{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] tabular-nums focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-[#1F1F1F] dark:bg-[#111111] dark:text-[#FAFAFA]',
            readOnly && 'cursor-default bg-slate-50 text-slate-600 dark:bg-[#0A0A0A] dark:text-[#A1A1AA]',
          )}
        />
        <span className="shrink-0 text-[12px] text-slate-500 dark:text-[#A1A1AA]">{unit}</span>
      </span>
      <span className="mt-0.5 block text-[11px] text-slate-400 dark:text-[#71717A]">{hint}</span>
    </label>
  );
}

export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-[#1F1F1F] dark:bg-[#0F0F0F]">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-slate-900 dark:text-[#FAFAFA]">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'warn' | 'accent';
}) {
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-[#1F1F1F] dark:bg-[#141414]">
      <div className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-[16px] font-semibold tabular-nums text-slate-900 dark:text-[#FAFAFA]',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'warn' && 'text-amber-700 dark:text-amber-400',
          tone === 'accent' && 'text-indigo-700 dark:text-indigo-300',
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">{sub}</div> : null}
    </div>
  );
}
