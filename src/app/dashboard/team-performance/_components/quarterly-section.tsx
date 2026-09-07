import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import { formatCoverageRatio } from '@/lib/dashboard/coverage';
import {
  PACE_STATUS_LABELS,
  type Pace,
  type PaceStatus,
} from '@/lib/targets/quarters';
import type { ScorecardQuarter, TeamScorecard } from '@/lib/team-analytics/scorecard';

import { dealsHref } from './drill-links';
import {
  Chip,
  DeltaBadge,
  PctCell,
  RepCell,
  Section,
  TableFrame,
  Td,
  Th,
  Notes,
  type ChipTone,
} from './scorecard-primitives';

const PACE_TONES: Record<PaceStatus, ChipTone> = {
  ahead: 'good',
  'on-track': 'good',
  behind: 'warn',
  'at-risk': 'bad',
};

/**
 * How a quarter's result should read.
 *
 * A quarter that has not finished is NEVER coloured as a miss — Q3 at 20%
 * in its second week is not a problem, and painting it red would train
 * everyone to ignore the colour. Only completed quarters get a verdict.
 */
function quarterTone(q: ScorecardQuarter): ChipTone {
  if (q.targetMinor <= 0) return 'neutral';
  const ratio = q.revenueMinor / q.targetMinor;
  if (ratio >= 1) return 'good';
  if (!q.isComplete) return 'neutral';
  return ratio >= 0.8 ? 'warn' : 'bad';
}

function PaceChip({ pace }: { pace: Pace }) {
  if (pace.state === 'no-target') {
    return <span className="text-slate-400">no target</span>;
  }
  if (pace.state === 'not-started') {
    return <span className="text-slate-400">not started</span>;
  }
  return (
    <Chip
      tone={PACE_TONES[pace.status]}
      title={`${Math.round(pace.ratio * 100)}% of the straight-line pace for this point in the year`}
    >
      {PACE_STATUS_LABELS[pace.status]}
    </Chip>
  );
}

/**
 * QUARTERLY PROGRESSION + COMMITMENT.
 *
 * The four quarter columns say where the year's revenue landed; the three
 * on the right say whether what is left is reachable. They are on one row
 * on purpose: "62% attained" and "needs ₹1.2 Cr a month for the rest of
 * the year" are the same conversation, and splitting them across two
 * tables is what lets a team agree the first number is fine without ever
 * looking at the second.
 */
export function QuarterlySection({
  scorecard,
  ctx,
  fiscalLabel,
}: {
  scorecard: TeamScorecard;
  ctx: TenantCurrencyContext;
  fiscalLabel: string;
}) {
  const { rows, team } = scorecard;
  const money = (minor: number) => formatCompactTenantCurrency(minor, ctx);
  const fullMoney = (minor: number) => formatTenantCurrency(minor, ctx);

  const anyDerivedTarget = rows.some((r) => r.revenueTargetMinor > 0);
  const missingTargets = rows.filter((r) => r.revenueTargetMinor <= 0).length;

  return (
    <Section
      title={`Quarterly progression · ${fiscalLabel}`}
      subtitle={
        <>
          Each quarter shows the revenue attributable to it — a multi-year
          contract contributes only the slice of its value that falls inside
          the quarter, the same rule the Targets page uses for the year. The
          four quarters therefore add up to the annual figure on the right.
        </>
      }
    >
      <TableFrame>
        <thead>
          <tr>
            <Th align="left" sticky>
              Rep
            </Th>
            {team.quarters.map((q) => (
              <Th
                key={q.index}
                title={`${q.label}: ${q.isComplete ? 'complete' : q.isCurrent ? 'in progress' : 'not started'}`}
              >
                {q.label}
                {q.isCurrent ? (
                  <span className="ml-1 font-normal normal-case text-indigo-500">
                    now
                  </span>
                ) : null}
              </Th>
            ))}
            <Th title="This fiscal year's revenue as a share of the annual target, and its change since the last month close">
              {fiscalLabel}
            </Th>
            <Th title="Annual revenue target from Settings → Targets">
              Target
            </Th>
            <Th align="center" title="Attainment measured against a straight line through the year">
              Pace
            </Th>
            <Th title="Remaining target divided by the months left in the year">
              Need / mo
            </Th>
            <Th title="Open pipeline divided by the remaining gap. 3x is the conventional floor">
              Coverage
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const attainRatio =
              r.revenueTargetMinor > 0
                ? r.fyRevenueMinor / r.revenueTargetMinor
                : 0;
            return (
              <tr key={r.userId}>
                <RepCell
                  name={r.displayName}
                  role={r.role}
                  href={dealsHref({ ownerId: r.userId })}
                />
                {r.quarters.map((q) => (
                  <Td
                    key={q.index}
                    muted={q.revenueMinor === 0}
                    title={
                      q.targetMinor > 0
                        ? `${fullMoney(q.revenueMinor)} of ${fullMoney(q.targetMinor)} · ${q.wonCount} won`
                        : `${fullMoney(q.revenueMinor)} · ${q.wonCount} won`
                    }
                  >
                    <span className="block leading-tight">
                      {q.revenueMinor === 0 ? '—' : money(q.revenueMinor)}
                    </span>
                    <span
                      className={cnQuarterMeta(quarterTone(q))}
                    >
                      {q.wonCount > 0 ? `${q.wonCount} won` : ' '}
                    </span>
                  </Td>
                ))}
                {r.revenueTargetMinor > 0 ? (
                  <PctCell
                    delta={
                      <DeltaBadge
                        delta={r.deltas.attainment}
                        formatChange={(n) => money(n)}
                      />
                    }
                    ratio={attainRatio}
                    tone={
                      attainRatio >= 1
                        ? 'good'
                        : r.pace.state === 'tracked'
                          ? PACE_TONES[r.pace.status]
                          : 'neutral'
                    }
                    title={`${fullMoney(r.fyRevenueMinor)} of ${fullMoney(r.revenueTargetMinor)}`}
                  />
                ) : (
                  <Td muted title={fullMoney(r.fyRevenueMinor)}>
                    {money(r.fyRevenueMinor)}
                  </Td>
                )}
                <Td muted={r.revenueTargetMinor <= 0}>
                  {r.revenueTargetMinor > 0 ? money(r.revenueTargetMinor) : '—'}
                </Td>
                <Td align="center">
                  <PaceChip pace={r.pace} />
                </Td>
                <Td
                  muted={
                    r.pace.state !== 'tracked' ||
                    r.pace.requiredPerMonthMinor == null
                  }
                  title={
                    r.pace.state === 'tracked'
                      ? `${fullMoney(r.pace.gapMinor)} left over ${r.pace.monthsLeft.toFixed(1)} months`
                      : undefined
                  }
                >
                  {r.pace.state === 'tracked' &&
                  r.pace.requiredPerMonthMinor != null
                    ? r.pace.gapMinor > 0
                      ? money(r.pace.requiredPerMonthMinor)
                      : 'met'
                    : '—'}
                </Td>
                <Td muted={r.coverage.state !== 'covered'}>
                  {r.coverage.state === 'covered' ? (
                    <Chip
                      tone={
                        r.coverage.band === 'healthy'
                          ? 'good'
                          : r.coverage.band === 'thin'
                            ? 'warn'
                            : 'bad'
                      }
                      title={`${fullMoney(r.coverage.gapMinor)} still to close`}
                    >
                      {formatCoverageRatio(r.coverage.ratio)}
                    </Chip>
                  ) : r.coverage.state === 'met' ? (
                    'met'
                  ) : (
                    '—'
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-medium">
            <Td sticky align="left">
              Team
            </Td>
            {team.quarters.map((q) => (
              <Td key={q.index} title={fullMoney(q.revenueMinor)}>
                {q.revenueMinor === 0 ? '—' : money(q.revenueMinor)}
              </Td>
            ))}
            <Td title={fullMoney(team.fyRevenueMinor)}>
              <span className="flex items-center justify-end gap-1">
                {money(team.fyRevenueMinor)}
                <DeltaBadge delta={team.deltas.attainment} />
              </span>
            </Td>
            <Td title={fullMoney(team.revenueTargetMinor)}>
              {team.revenueTargetMinor > 0
                ? money(team.revenueTargetMinor)
                : '—'}
            </Td>
            <Td align="center">
              <PaceChip pace={team.pace} />
            </Td>
            <Td
              muted={
                team.pace.state !== 'tracked' ||
                team.pace.requiredPerMonthMinor == null
              }
            >
              {team.pace.state === 'tracked' &&
              team.pace.requiredPerMonthMinor != null
                ? team.pace.gapMinor > 0
                  ? money(team.pace.requiredPerMonthMinor)
                  : 'met'
                : '—'}
            </Td>
            <Td muted={team.coverage.state !== 'covered'}>
              {team.coverage.state === 'covered'
                ? formatCoverageRatio(team.coverage.ratio)
                : team.coverage.state === 'met'
                  ? 'met'
                  : '—'}
            </Td>
          </tr>
        </tfoot>
      </TableFrame>

      <Notes
        notes={[
          anyDerivedTarget
            ? 'Quarterly targets are the annual target split evenly in four — the workspace stores one annual figure per rep, not four quarterly ones. A quarter reads as a miss against that straight line, not against a plan anyone set.'
            : null,
          missingTargets > 0
            ? `${missingTargets} ${missingTargets === 1 ? 'rep has' : 'reps have'} no target for this year — their revenue is shown but no pace or coverage can be computed for it.`
            : null,
          'Open pipeline behind the coverage column is today’s pipeline, not the pipeline as it stood during the selected year.',
        ]}
      />
    </Section>
  );
}

/** Tiny helper so the quarter sub-label picks up the quarter's verdict. */
function cnQuarterMeta(tone: ChipTone): string {
  const base = 'block text-[10px] font-normal ';
  if (tone === 'good') return `${base}text-emerald-600 dark:text-emerald-400`;
  if (tone === 'warn') return `${base}text-amber-600 dark:text-amber-400`;
  if (tone === 'bad') return `${base}text-rose-600 dark:text-rose-400`;
  return `${base}text-slate-400 dark:text-[#71717A]`;
}
