import { withTenantSession } from '@/lib/auth-guard';
import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
} from '@/lib/currency/format';
import { bandFor, ratioOf } from '@/lib/deals/completeness';
import { getOrgSettings } from '@/lib/org-settings/queries';
import { requirePersonas } from '@/lib/personas/guards';
import {
  currentFiscalYear,
  fiscalYearChoices,
  fiscalYearLabel,
} from '@/lib/targets/fiscal';
import { PACE_STATUS_LABELS, paceNote } from '@/lib/targets/quarters';
import { periodLabel } from '@/lib/team-analytics/deltas';
import { STALE_DEAL_DAYS, weekLabel } from '@/lib/team-analytics/engagement';
import { getTeamScorecard } from '@/lib/team-analytics/scorecard';

import { MetricCard, type MetricTone } from '../_components/metric-card';
import { DeltaBadge } from './_components/scorecard-primitives';
import { FiscalYearSelect } from '../targets/_components/fy-select';

import { CompletenessSection } from './_components/completeness-section';
import { EngagementSection } from './_components/engagement-section';
import { PushbackSection } from './_components/pushback-section';
import { QuarterlySection } from './_components/quarterly-section';

export const metadata = { title: 'Team Performance' };

/** The completeness bands, in the KPI strip's tone vocabulary. */
const COMPLETENESS_TONES = {
  good: 'success',
  patchy: 'warning',
  poor: 'danger',
} as const satisfies Record<string, MetricTone>;

/**
 * TEAM PERFORMANCE — the manager's accountability surface.
 *
 * The dashboard answers "how is the business doing" and the Targets page
 * answers "how much has each rep closed". Neither answers the questions a
 * sales leader asks in a pipeline review:
 *
 *   · Who keeps moving their close dates, and what has it cost?
 *   · Did the year land in the quarters we planned it to?
 *   · Who is feeding the pipeline, and who has gone quiet on the deals
 *     they already have?
 *   · Whose deals are missing the fields everything downstream reads?
 *
 * All four are on one page because they are one conversation. A rep at
 * 95% attainment whose whole book has slipped a quarter and whose deals
 * carry no next step is not the same as a rep at 95% with a clean book,
 * and no single number distinguishes them.
 *
 * Scoped to admins and managers. A rep's own version of these figures is
 * `/dashboard/my-performance`; this page is deliberately comparative, and
 * a cross-rep leaderboard is not something a rep should be handed by
 * default.
 */
export default async function TeamPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  await requirePersonas(['admin', 'manager']);

  return await withTenantSession(async ({ tenant }) => {
    const settings = await getOrgSettings(tenant.id);
    const startMonth = settings.fiscalYearStartMonth ?? 1;
    const now = new Date();
    const choices = fiscalYearChoices(startMonth, now);
    const sp = await searchParams;
    const parsedFy = Number(sp.fy);
    const fiscalYear =
      Number.isInteger(parsedFy) && choices.includes(parsedFy)
        ? parsedFy
        : currentFiscalYear(startMonth, now);

    const scorecard = await getTeamScorecard(
      tenant.id,
      tenant.name,
      fiscalYear,
      startMonth,
      now,
    );

    const ctx = {
      defaultCurrency: settings.defaultCurrency,
      currencyLocale: settings.currencyLocale,
      compactNumbers: settings.compactNumbers,
    };
    const fiscalLabel = fiscalYearLabel(startMonth, fiscalYear);
    const { team } = scorecard;

    const attainmentRatio =
      team.revenueTargetMinor > 0
        ? team.fyRevenueMinor / team.revenueTargetMinor
        : 0;
    const paceTone: MetricTone =
      team.pace.state !== 'tracked'
        ? 'neutral'
        : team.pace.status === 'ahead' || team.pace.status === 'on-track'
          ? 'success'
          : team.pace.status === 'behind'
            ? 'warning'
            : 'danger';
    const completenessRatio = ratioOf(
      team.completeness.filled,
      team.completeness.applicable,
    );

    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5 lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-[#FAFAFA]">
              Team performance
            </h1>
            <p className="mt-0.5 max-w-2xl text-[13px] text-slate-500 dark:text-[#A1A1AA]">
              Where the year’s revenue landed, who is moving close dates, how
              actively each rep is working their book, and what their deals are
              missing. Everything is per rep and comparable across the team.
            </p>
          </div>
          <FiscalYearSelect
            value={fiscalYear}
            choices={choices.map((y) => ({
              value: y,
              label: fiscalYearLabel(startMonth, y),
            }))}
          />
        </div>

        {/* Five tiles, one per question the page answers. Each is a
            headline for the section below it, never a number that appears
            nowhere else. */}
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard
            label={`${fiscalLabel} attainment`}
            value={
              team.revenueTargetMinor > 0
                ? `${Math.round(attainmentRatio * 100)}%`
                : formatCompactTenantCurrency(team.fyRevenueMinor, ctx)
            }
            hint={
              team.revenueTargetMinor > 0
                ? `${formatCompactTenantCurrency(team.fyRevenueMinor, ctx)} of ${formatCompactTenantCurrency(team.revenueTargetMinor, ctx)} · ${
                    team.pace.state === 'tracked'
                      ? PACE_STATUS_LABELS[team.pace.status]
                      : 'no pace'
                  }`
                : 'No targets set for this year'
            }
            trend={
              <DeltaBadge
                delta={team.deltas.attainment}
                variant="tile"
                formatChange={(n) => formatCompactTenantCurrency(n, ctx)}
              />
            }
            tone={paceTone}
            emptyState={
              team.revenueTargetMinor <= 0 && team.fyRevenueMinor <= 0
                ? 'No targets or closed revenue yet'
                : undefined
            }
          />
          <MetricCard
            label="Close dates pushed"
            value={team.pushEvents}
            hint={
              team.pushEvents > 0
                ? `${team.daysPushed} days added this year`
                : 'No deal has slipped this year'
            }
            trend={
              <DeltaBadge delta={team.deltas.pushEvents} variant="tile" />
            }
            tone={
              team.pushEvents === 0
                ? 'success'
                : team.daysPushed >= 90
                  ? 'danger'
                  : 'warning'
            }
          />
          <MetricCard
            label="Deals added"
            value={team.dealsCreated}
            hint={
              team.bestWeek
                ? `Best week: ${team.bestWeek.displayName}, ${team.bestWeek.count} in ${weekLabel(
                    team.bestWeek.weekStart,
                  ).replace('Week of ', 'w/c ')}`
                : 'None created this year'
            }
            trend={
              <DeltaBadge delta={team.deltas.dealsCreated} variant="tile" />
            }
            tone="info"
          />
          <MetricCard
            label="Untouched deals"
            value={
              team.openDeals > 0
                ? `${team.staleOpenDeals}/${team.openDeals}`
                : '—'
            }
            hint={`Open, no change in ${STALE_DEAL_DAYS}+ days · as of today`}
            trend={
              <DeltaBadge delta={team.deltas.staleOpenDeals} variant="tile" />
            }
            tone={
              team.openDeals === 0
                ? 'neutral'
                : team.staleOpenDeals / team.openDeals >= 0.4
                  ? 'danger'
                  : team.staleOpenDeals > 0
                    ? 'warning'
                    : 'success'
            }
            emptyState={team.openDeals === 0 ? 'No open deals' : undefined}
          />
          <MetricCard
            label="Field completeness"
            value={`${Math.round(completenessRatio * 100)}%`}
            hint={`Of what open deals owe at their stage · ${team.openDeals} deals`}
            trend={
              <DeltaBadge delta={team.deltas.completeness} variant="tile" />
            }
            // The default ladder, same one the Overall column below uses —
            // so the tile can't call 60% healthy while the column beneath
            // it calls the same number amber. Individual fields have their
            // own ladders; a roll-up across all of them does not.
            tone={
              COMPLETENESS_TONES[bandFor(Math.round(completenessRatio * 100))]
            }
            emptyState={
              team.completeness.applicable === 0
                ? 'No open deals to score'
                : undefined
            }
          />
        </div>

        {/* Where every arrow above is measured from. Stated once, out loud:
            a delta whose basis is unnamed is the ambiguity this whole pass
            exists to remove. */}
        <p className="mt-2 text-[11px] text-slate-400 dark:text-[#71717A]">
          {scorecard.baselinePeriods.state || scorecard.baselinePeriods.cumulative
            ? `Change measured against the ${periodLabel(
                scorecard.baselinePeriods.state ??
                  scorecard.baselinePeriods.cumulative,
              )} month close.`
            : 'No month-close snapshot has been captured yet, so nothing on this page has a comparison. The first one lands on the 1st of next month.'}
        </p>

        {team.pace.state === 'tracked' ? (
          <p className="mt-2 text-[11.5px] text-slate-500 dark:text-[#A1A1AA]">
            {paceNote(team.pace, (minor) => formatTenantCurrency(minor, ctx))}
            {team.pace.gapMinor > 0 && team.pace.requiredPerMonthMinor != null
              ? ` — ${formatTenantCurrency(team.pace.gapMinor, ctx)} left, which is ${formatTenantCurrency(
                  team.pace.requiredPerMonthMinor,
                  ctx,
                )} a month for the rest of the year.`
              : null}
          </p>
        ) : null}

        <div className="mt-5 space-y-4">
          <QuarterlySection
            scorecard={scorecard}
            ctx={ctx}
            fiscalLabel={fiscalLabel}
          />
          <PushbackSection scorecard={scorecard} ctx={ctx} />
          <EngagementSection scorecard={scorecard} ctx={ctx} />
          <CompletenessSection scorecard={scorecard} />
        </div>

        {scorecard.rows.length === 0 ? (
          <p className="mt-4 rounded-lg border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500 dark:border-[#1F1F1F] dark:bg-[#0A0A0A] dark:text-[#A1A1AA]">
            No sales team members found for this workspace yet.
          </p>
        ) : null}
      </main>
    );
  });
}
