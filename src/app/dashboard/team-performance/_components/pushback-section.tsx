import Link from 'next/link';

import {
  formatCompactTenantCurrency,
  formatTenantCurrency,
  type TenantCurrencyContext,
} from '@/lib/currency/format';
import { SEVERE_PUSH_COUNT } from '@/lib/deals/slip';
import type { TeamScorecard } from '@/lib/team-analytics/scorecard';

import {
  Chip,
  EmptyRow,
  Notes,
  RepCell,
  Section,
  TableFrame,
  Td,
  Th,
} from './scorecard-primitives';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * CLOSE-DATE PUSHBACKS — who is moving deals to the right, and what it
 * has cost.
 *
 * Sorted by push count because that is the question ("who has pushed the
 * most"), but the count alone is a trap: a rep carrying 40 deals will
 * out-push a rep carrying 8 without being any less disciplined. So the
 * table also carries days added (the actual damage), the number of
 * distinct deals involved, and pushes per deal — the shape that tells
 * "one runaway deal" apart from "the whole book is slipping".
 */
export function PushbackSection({
  scorecard,
  ctx,
}: {
  scorecard: TeamScorecard;
  ctx: TenantCurrencyContext;
}) {
  const { rows, team, window, pushbackRecordedSince } = scorecard;
  const money = (minor: number) => formatCompactTenantCurrency(minor, ctx);
  const fullMoney = (minor: number) => formatTenantCurrency(minor, ctx);

  const pushers = rows.filter((r) => r.pushback.pushEvents > 0);
  const byOthers = rows.reduce((n, r) => n + r.pushback.pushedByOthers, 0);
  const deweighted = rows.reduce((n, r) => n + r.pushback.deweightedCount, 0);

  // A window that starts before logging did cannot see the whole story,
  // and a rep with no rows in it may simply pre-date the log.
  const partialHistory =
    pushbackRecordedSince != null && pushbackRecordedSince > window.from;

  return (
    <Section
      title="Close-date pushbacks"
      subtitle={
        <>
          Every forward move of an expected close date in this fiscal year,
          attributed to the deal’s current owner. Pull-ins and corrections
          are not pushes and are not counted here.
        </>
      }
      aside={
        <span className="text-[11px] text-slate-400 dark:text-[#71717A]">
          {team.pushEvents} {team.pushEvents === 1 ? 'push' : 'pushes'} ·{' '}
          {team.daysPushed} days added
        </span>
      }
    >
      {pushers.length === 0 ? (
        <EmptyRow>
          No close date has been pushed in this fiscal year.
          {partialHistory
            ? ` Pushbacks have only been recorded since ${dateFormatter.format(pushbackRecordedSince)}.`
            : ''}
        </EmptyRow>
      ) : (
        <TableFrame>
          <thead>
            <tr>
              <Th align="left" sticky>
                Rep
              </Th>
              <Th title="Individual forward moves of a close date">Pushes</Th>
              <Th title="Distinct deals those pushes landed on">Deals</Th>
              <Th title="Pushes ÷ deals — tells one runaway deal apart from a book-wide slip">
                Per deal
              </Th>
              <Th title="Calendar days added across every push">Days added</Th>
              <Th title="Value of the pushed deals that are still open">
                Still open
              </Th>
              <Th title={`Deals pushed more than ${SEVERE_PUSH_COUNT} times now count at half value toward quota`}>
                De-weighted
              </Th>
              <Th align="left" title="The single deal that moved the most">
                Worst deal
              </Th>
            </tr>
          </thead>
          <tbody>
            {pushers.map((r) => {
              const p = r.pushback;
              const perDeal = p.dealsPushed > 0 ? p.pushEvents / p.dealsPushed : 0;
              return (
                <tr key={r.userId}>
                  <RepCell name={r.displayName} role={r.role} />
                  <Td
                    className="font-semibold text-slate-900 dark:text-[#FAFAFA]"
                    title={
                      p.pushedByOthers > 0
                        ? `${p.pushedByOthers} of these were made by someone other than the owner`
                        : undefined
                    }
                  >
                    {p.pushEvents}
                    {p.pushedByOthers > 0 ? (
                      <span className="ml-1 text-[10px] font-normal text-slate-400">
                        ({p.pushedByOthers} by others)
                      </span>
                    ) : null}
                  </Td>
                  <Td>{p.dealsPushed}</Td>
                  <Td muted={perDeal < 2}>{perDeal.toFixed(1)}×</Td>
                  <Td>
                    <Chip
                      tone={
                        p.daysPushed >= 90
                          ? 'bad'
                          : p.daysPushed >= 30
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {p.daysPushed}d
                    </Chip>
                  </Td>
                  <Td
                    muted={p.openPushedValueMinor === 0}
                    title={fullMoney(p.openPushedValueMinor)}
                  >
                    {p.openPushedValueMinor > 0
                      ? money(p.openPushedValueMinor)
                      : '—'}
                  </Td>
                  <Td muted={p.deweightedCount === 0}>
                    {p.deweightedCount > 0 ? (
                      <Chip tone="bad">{p.deweightedCount}</Chip>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td align="left" muted={!p.worstDeal}>
                    {p.worstDeal ? (
                      <Link
                        href={`/dashboard/deals/${p.worstDeal.id}`}
                        className="text-indigo-600 hover:text-indigo-500 dark:text-indigo-300"
                        title={`Pushed ${p.worstDeal.pushes}× · ${p.worstDeal.days} days`}
                      >
                        <span className="block max-w-[200px] truncate">
                          {p.worstDeal.name}
                        </span>
                        <span className="block text-[10px] font-normal text-slate-400">
                          ×{p.worstDeal.pushes} · {p.worstDeal.days}d
                        </span>
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableFrame>
      )}

      <Notes
        notes={[
          partialHistory
            ? `Close-date changes have only been recorded since ${dateFormatter.format(pushbackRecordedSince)} — anything moved before that is invisible here, so an empty row is not proof of a clean record.`
            : null,
          byOthers > 0
            ? `${byOthers} of these pushes were made by someone other than the deal’s owner (a manager, an import, a bulk edit). They are still counted against the owner, because it is their deal that slipped.`
            : null,
          deweighted > 0
            ? `${deweighted} ${deweighted === 1 ? 'deal is' : 'deals are'} currently counted at half value toward quota for having been pushed more than ${SEVERE_PUSH_COUNT} times. The Targets page shows the revenue that removes.`
            : null,
        ]}
      />
    </Section>
  );
}
