import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import {
  ACTIVITY_BAND_LABELS,
  STALE_DEAL_DAYS,
  activityBand,
  agoLabel,
  weekLabel,
  weeksIn,
} from '@/lib/team-analytics/engagement';
import type { TeamScorecard } from '@/lib/team-analytics/scorecard';

import {
  Chip,
  Notes,
  RepCell,
  Section,
  TableFrame,
  Td,
  Th,
  type ChipTone,
} from './scorecard-primitives';

const BAND_TONES: Record<'active' | 'quiet' | 'silent', ChipTone> = {
  active: 'good',
  quiet: 'neutral',
  silent: 'bad',
};

/**
 * ENGAGEMENT — cadence on the left, silence on the right.
 *
 * The left half answers "who is feeding the pipeline" (deals added, best
 * week, weekly rate) and the right half answers "who has stopped touching
 * what they already have" (open deals untouched for two weeks, days since
 * anything of theirs moved). Both halves are about the same rep and they
 * routinely disagree — a rep can be top of the creation column and bottom
 * of the freshness one — which is exactly why they sit in one table.
 */
export function EngagementSection({
  scorecard,
  ctx,
}: {
  scorecard: TeamScorecard;
  ctx: TenantCurrencyContext;
}) {
  const { rows, team, window } = scorecard;
  const money = (minor: number) => formatCompactTenantCurrency(minor, ctx);
  const fullMoney = (minor: number) => formatTenantCurrency(minor, ctx);
  const weeks = weeksIn(window.from, window.to);

  const noOwnedDeals = rows.filter(
    (r) => r.engagement.openDeals === 0 && r.engagement.dealsCreated === 0,
  ).length;

  return (
    <Section
      title="Engagement & cadence"
      subtitle={
        <>
          Deals added and activity are for this fiscal year to date. Open
          deals, untouched counts and “last touch” are as of today — a deal
          left alone for a month is left alone now, whichever year is
          selected above.
        </>
      }
      aside={
        team.bestWeek ? (
          <span className="text-[11px] text-slate-500 dark:text-[#A1A1AA]">
            Busiest week:{' '}
            <span className="font-medium text-slate-900 dark:text-[#FAFAFA]">
              {team.bestWeek.displayName}
            </span>{' '}
            · {team.bestWeek.count} deals ·{' '}
            {weekLabel(team.bestWeek.weekStart).replace('Week of ', 'w/c ')}
          </span>
        ) : null
      }
    >
      <TableFrame>
        <thead>
          <tr>
            <Th align="left" sticky>
              Rep
            </Th>
            <Th title="Deals created in this fiscal year that this rep owns">
              Added
            </Th>
            <Th title="Value of the deals they added">Added value</Th>
            <Th title="Their single busiest week of deal creation">
              Best week
            </Th>
            <Th title="Deals added ÷ whole weeks in the window">Per week</Th>
            <Th title="Weeks in which they created at least one deal">
              Active wks
            </Th>
            <Th title="Open deals they own right now">Open</Th>
            <Th title={`Open deals with no change for ${STALE_DEAL_DAYS}+ days`}>
              Untouched
            </Th>
            <Th title="Days since any deal they own was last changed">
              Last touch
            </Th>
            <Th align="center" title="Days since their last logged activity of any kind">
              Activity
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const e = r.engagement;
            const band = activityBand(e.daysSinceLastActivity);
            const staleRatio =
              e.openDeals > 0 ? e.staleOpenDeals / e.openDeals : 0;
            return (
              <tr key={r.userId}>
                <RepCell name={r.displayName} role={r.role} />
                <Td
                  muted={e.dealsCreated === 0}
                  className={
                    e.dealsCreated > 0
                      ? 'font-semibold text-slate-900 dark:text-[#FAFAFA]'
                      : undefined
                  }
                >
                  {e.dealsCreated || '—'}
                </Td>
                <Td
                  muted={e.createdValueMinor === 0}
                  title={fullMoney(e.createdValueMinor)}
                >
                  {e.createdValueMinor > 0 ? money(e.createdValueMinor) : '—'}
                </Td>
                <Td muted={e.bestWeekCount === 0} align="right">
                  {e.bestWeekCount > 0 ? (
                    <>
                      <span className="block leading-tight">
                        {e.bestWeekCount} deals
                      </span>
                      <span className="block text-[10px] font-normal text-slate-400">
                        {weekLabel(e.bestWeekStart).replace('Week of ', 'w/c ')}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td muted={e.dealsCreated === 0}>
                  {e.dealsCreated > 0 ? (e.dealsCreated / weeks).toFixed(1) : '—'}
                </Td>
                <Td muted={e.activeWeeks === 0}>
                  {e.activeWeeks > 0 ? `${e.activeWeeks}/${weeks}` : '—'}
                </Td>
                <Td muted={e.openDeals === 0}>{e.openDeals || '—'}</Td>
                <Td
                  muted={e.staleOpenDeals === 0}
                  title={
                    e.oldestUntouchedDays != null
                      ? `Oldest untouched open deal: ${e.oldestUntouchedDays} days`
                      : undefined
                  }
                >
                  {e.staleOpenDeals > 0 ? (
                    <Chip
                      tone={
                        staleRatio >= 0.5
                          ? 'bad'
                          : staleRatio >= 0.25
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {e.staleOpenDeals}/{e.openDeals}
                    </Chip>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td muted={e.daysSinceLastTouch == null}>
                  {agoLabel(e.daysSinceLastTouch)}
                </Td>
                <Td align="center" muted={band == null}>
                  {band ? (
                    <Chip
                      tone={BAND_TONES[band]}
                      title={`${e.activityCount} logged actions this year · last ${agoLabel(e.daysSinceLastActivity)}`}
                    >
                      {ACTIVITY_BAND_LABELS[band]}
                    </Chip>
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
            <Td>{team.dealsCreated || '—'}</Td>
            <Td muted>—</Td>
            <Td muted>—</Td>
            <Td>{(team.dealsCreated / weeks).toFixed(1)}</Td>
            <Td muted>—</Td>
            <Td>{team.openDeals || '—'}</Td>
            <Td>
              {team.staleOpenDeals > 0
                ? `${team.staleOpenDeals}/${team.openDeals}`
                : '—'}
            </Td>
            <Td muted>—</Td>
            <Td muted>—</Td>
          </tr>
        </tfoot>
      </TableFrame>

      <Notes
        notes={[
          'A deal counts toward the rep who OWNS it, not whoever typed it in — a reassigned deal moves its whole history with it.',
          '“Last touch” moves on any write to a deal row, so a bulk edit refreshes it and a call logged as a note does not. The Activity column is the complementary signal; neither is a complete picture of effort on its own.',
          noOwnedDeals > 0
            ? `${noOwnedDeals} ${noOwnedDeals === 1 ? 'person owns' : 'people own'} no deals at all in this workspace — an empty row there is a missing assignment, not inactivity.`
            : null,
        ]}
      />
    </Section>
  );
}
