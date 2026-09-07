import { AlertTriangle, Info } from 'lucide-react';

import type { DealRiskRow } from '@/lib/deals/risk/queries';
import { RISK_BAND_LABELS, type RiskBand } from '@/lib/deals/risk/score';
import { cn } from '@/lib/utils';

/**
 * DEAL RISK (Phase 1) on the deal record.
 *
 * Three things this card is careful about, because all three are ways a
 * score like this misleads:
 *
 * 1. IT SAYS WHICH WAY IT POINTS. The Deal Score card directly above it is a
 *    HEALTH score where 100 is good. This one is risk, where 100 is bad. The
 *    header says "higher is worse" rather than trusting a colour to carry it.
 * 2. IT SAYS WHAT IT IS. "Rules-based" is in the header, not buried in a
 *    tooltip. This is a weighted checklist, not a trained model, and a number
 *    that looks like a prediction must not borrow the authority of one.
 * 3. IT SHOWS ITS WORKING. Every point is attributed to a named factor with
 *    the actual figure behind it, so a rep who disagrees can check rather
 *    than argue with a black box.
 */

const BAND_STYLES: Record<RiskBand, { chip: string; bar: string; text: string }> = {
  low: {
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
    bar: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  elevated: {
    chip: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
    bar: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-300',
  },
  high: {
    chip: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
    bar: 'bg-rose-500',
    text: 'text-rose-700 dark:text-rose-300',
  },
};

export function DealRiskCard({ risk }: { risk: DealRiskRow }) {
  const style = BAND_STYLES[risk.band];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] dark:border-[#1F1F1F] dark:bg-[#0A0A0A]">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-[13.5px] font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
            <AlertTriangle className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            Deal risk
          </h2>
          {/* Three disclosures up front, because this card sits beside a
              second 0-100 score that runs the other way: which direction is
              bad, what the number is made of, and that it is a checklist
              rather than a trained model. */}
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-[#A1A1AA]">
            Higher is worse · pushbacks, silence, missing fields
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400 dark:text-[#71717A]">
            Rules-based, not a trained model
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
            style.chip,
          )}
        >
          {RISK_BAND_LABELS[risk.band]}
        </span>
      </header>

      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono text-[26px] font-semibold leading-none tabular-nums',
            style.text,
          )}
        >
          {risk.score}
        </span>
        <span className="text-[11px] text-slate-400 dark:text-[#71717A]">
          / 100 risk
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-[#1F1F1F]">
        <div
          className={cn('h-full rounded-full', style.bar)}
          style={{ width: `${Math.min(100, Math.max(0, risk.score))}%` }}
        />
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-slate-700 dark:text-[#D4D4D8]">
        {risk.explanation}
      </p>

      {risk.factors.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2.5 dark:border-[#1F1F1F]">
          {risk.factors.map((f) => (
            <li
              key={f.key}
              className="flex items-baseline justify-between gap-3 text-[11.5px]"
            >
              <span className="text-slate-600 dark:text-[#A1A1AA]">{f.detail}</span>
              <span className="shrink-0 font-medium tabular-nums text-slate-400 dark:text-[#71717A]">
                +{f.points}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 border-t border-slate-100 pt-2.5 text-[11.5px] text-slate-500 dark:border-[#1F1F1F] dark:text-[#A1A1AA]">
          No risk signals on this deal.
        </p>
      )}

      <p className="mt-2.5 flex items-start gap-1 text-[10.5px] leading-snug text-slate-400 dark:text-[#71717A]">
        <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
        <span>
          {risk.explanationFromModel
            ? 'Summary written by Claude from the factors below it; the factors and the score are computed, not generated.'
            : 'Summary assembled from the factors below it — no Claude key configured.'}{' '}
          Updated nightly. Separate from Deal health below, which measures
          engagement and runs the opposite way.
        </span>
      </p>
    </section>
  );
}
